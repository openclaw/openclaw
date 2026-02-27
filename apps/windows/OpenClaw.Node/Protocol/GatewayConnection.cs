using System;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Concurrent;
using System.Collections.Generic;
using OpenClaw.Node.Services;

namespace OpenClaw.Node.Protocol
{
    public class GatewayConnection : IDisposable, IGatewayRpcClient
    {
        private ClientWebSocket? _webSocket;
        private readonly Uri _serverUri;
        private readonly string _token;
        private readonly ConnectParams _connectParams;
        private CancellationTokenSource _cts = new();
        private string? _pendingConnectRequestId;
        private readonly DeviceIdentityService _deviceIdentityService = new();
        private DeviceIdentityService.DeviceIdentity? _deviceIdentity;

        // Resilience
        private int _backoffMs = 500;
        private DateTime _lastTickTime;
        private int _tickIntervalMs = 30000;
        private bool _connected = false;

        public event Action<string>? OnLog;
        public event Action<EventFrame>? OnEventReceived;
        public event Action? OnConnected;
        public event Action? OnDisconnected;
        public event Action<string>? OnConnectRejected;
        public event Func<BridgeInvokeRequest, Task<BridgeInvokeResponse>>? OnNodeInvoke;

        private readonly ConcurrentDictionary<string, Func<RequestFrame, Task<object?>>> _methodHandlers = new();
        private readonly SemaphoreSlim _sendLock = new(1, 1);
        private CancellationTokenSource? _activeReceiveCts;
        private int _activeReceiveGeneration;

        private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        public GatewayConnection(string serverUrl, string token, ConnectParams connectParams)
        {
            _serverUri = new Uri(serverUrl);
            _token = token;
            _connectParams = connectParams;
        }

        public void RegisterMethodHandler(string method, Func<RequestFrame, Task<object?>> handler)
        {
            _methodHandlers[method] = handler;
        }

        public async Task SendEventAsync(string eventName, object? payload, CancellationToken cancellationToken)
        {
            var eventFrame = new EventFrame
            {
                Type = "event",
                Event = eventName,
                Payload = payload
            };
            var json = JsonSerializer.Serialize(eventFrame, JsonOptions);
            await SendRawAsync(json, cancellationToken);
        }

        public async Task SendRequestAsync(string method, object? @params, CancellationToken cancellationToken)
        {
            var req = new RequestFrame
            {
                Type = "req",
                Id = Guid.NewGuid().ToString(),
                Method = method,
                Params = @params
            };
            var json = JsonSerializer.Serialize(req, JsonOptions);
            await SendRawAsync(json, cancellationToken);
        }

        public async Task StartAsync(CancellationToken cancellationToken)
        {
            _cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            _ = Task.Run(() => TickMonitorLoopAsync(_cts.Token), _cts.Token);

            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    await ConnectAndReceiveLoopAsync(_cts.Token);
                }
                catch (OperationCanceledException) { break; }
                catch (Exception ex)
                {
                    OnLog?.Invoke($"[Gateway] Disconnected: {ex.Message}");
                }

                if (!_cts.IsCancellationRequested)
                {
                    _backoffMs = Math.Min(_backoffMs * 2, 30000);
                    OnLog?.Invoke($"[Gateway] Reconnecting in {_backoffMs}ms...");
                    await Task.Delay(_backoffMs, _cts.Token);
                }
            }
        }

        private async Task ConnectAndReceiveLoopAsync(CancellationToken cancellationToken)
        {
            _connected = false;

            var receiveCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var receiveToken = receiveCts.Token;
            var receiveGeneration = Interlocked.Increment(ref _activeReceiveGeneration);

            CancellationTokenSource? previousReceiveCts;
            await _sendLock.WaitAsync(CancellationToken.None);
            try
            {
                previousReceiveCts = _activeReceiveCts;
                _activeReceiveCts = receiveCts;
            }
            finally
            {
                _sendLock.Release();
            }

            if (previousReceiveCts != null)
            {
                try { previousReceiveCts.Cancel(); } catch { }
                previousReceiveCts.Dispose();
            }

            var socket = new ClientWebSocket();
            socket.Options.SetRequestHeader("Authorization", $"Bearer {_token}");
            _webSocket = socket;

            OnLog?.Invoke($"[Gateway] Connecting to {_serverUri}...");
            try
            {
                await socket.ConnectAsync(_serverUri, receiveToken);
            }
            catch (Exception ex)
            {
                var lowered = ex.Message.ToLowerInvariant();
                if (lowered.Contains("401") || lowered.Contains("403") || lowered.Contains("unauthorized") || lowered.Contains("forbidden") || lowered.Contains("auth"))
                {
                    OnConnectRejected?.Invoke($"connect-failed: {ex.Message}");
                }

                await CleanupSocketAfterFailedAttemptAsync(socket);
                throw;
            }

            try
            {
                var buffer = new byte[16384];
                while (socket.State == WebSocketState.Open && !receiveToken.IsCancellationRequested)
                {
                    using var ms = new System.IO.MemoryStream();
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), receiveToken);
                        if (result.MessageType == WebSocketMessageType.Close) break;
                        ms.Write(buffer, 0, result.Count);
                    } while (!result.EndOfMessage);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        var code = result.CloseStatus?.ToString() ?? "n/a";
                        var reason = result.CloseStatusDescription ?? "n/a";
                        OnLog?.Invoke($"[Gateway] Socket closed by server. code={code} reason={reason}");
                        if (!_connected)
                        {
                            OnConnectRejected?.Invoke($"pre-connect-close code={code} reason={reason}");
                        }

                        await DisconnectAsync();
                        break;
                    }

                    var message = Encoding.UTF8.GetString(ms.ToArray());
                    _ = Task.Run(() => ProcessMessageAsync(message, receiveGeneration, receiveToken), receiveToken);
                }
            }
            catch
            {
                await CleanupSocketAfterFailedAttemptAsync(socket);
                throw;
            }
            finally
            {
                receiveCts.Cancel();

                await _sendLock.WaitAsync(CancellationToken.None);
                try
                {
                    if (ReferenceEquals(_activeReceiveCts, receiveCts))
                    {
                        _activeReceiveCts = null;
                    }
                }
                finally
                {
                    _sendLock.Release();
                }

                receiveCts.Dispose();
            }
        }

        private async Task CleanupSocketAfterFailedAttemptAsync(ClientWebSocket socket)
        {
            await _sendLock.WaitAsync(CancellationToken.None);
            try
            {
                if (ReferenceEquals(_webSocket, socket))
                {
                    _webSocket = null;
                }
            }
            finally
            {
                _sendLock.Release();
            }

            try
            {
                socket.Dispose();
            }
            catch
            {
                // best effort
            }
        }

        private async Task TickMonitorLoopAsync(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(1000, cancellationToken);
                
                if (!_connected) continue;

                var timeSinceLastTick = (DateTime.UtcNow - _lastTickTime).TotalMilliseconds;
                var tolerance = _tickIntervalMs + 5000; // 5s tolerance

                if (timeSinceLastTick > tolerance)
                {
                    OnLog?.Invoke($"[Gateway] Tick missed (elapsed: {timeSinceLastTick}ms, tolerance: {tolerance}ms). Forcing reconnect.");
                    await DisconnectAsync(); // This breaks the receive loop, triggering reconnect backoff
                }
            }
        }

        private async Task ProcessMessageAsync(string json, int receiveGeneration, CancellationToken cancellationToken)
        {
            if (receiveGeneration != Volatile.Read(ref _activeReceiveGeneration) || cancellationToken.IsCancellationRequested)
            {
                return;
            }

            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("type", out var typeElement))
                {
                    var type = typeElement.GetString();
                    if (type == "req")
                    {
                        var req = JsonSerializer.Deserialize<RequestFrame>(json, JsonOptions);
                        if (req != null) 
                        {
                            await HandleRequestAsync(req, cancellationToken);
                        }
                    }
                    else if (type == "event")
                    {
                        var evt = JsonSerializer.Deserialize<EventFrame>(json, JsonOptions);
                        if (evt != null) 
                        {
                            if (evt.Event == "tick")
                            {
                                _lastTickTime = DateTime.UtcNow;
                            }
                            else if (evt.Event == "connect.challenge")
                            {
                                await HandleConnectChallengeAsync(evt, cancellationToken);
                            }
                            else if (evt.Event == "node.invoke.request")
                            {
                                await HandleNodeInvokeRequestAsync(evt, cancellationToken);
                            }
                            else
                            {
                                OnEventReceived?.Invoke(evt);
                            }
                        }
                    }
                    else if (type == "res")
                    {
                        var res = JsonSerializer.Deserialize<ResponseFrame>(json, JsonOptions);
                        if (res != null)
                        {
                            await HandleResponseAsync(res);
                        }
                    }
                }
                else
                {
                    OnLog?.Invoke($"[Gateway] Unknown message format: {json}");
                }
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"[Gateway] Error processing message: {ex.Message}");
            }
        }

        private async Task HandleConnectChallengeAsync(EventFrame evt, CancellationToken cancellationToken)
        {
            OnLog?.Invoke("[Gateway] Received connect.challenge. Sending connect request...");

            var nonce = ExtractNonce(evt.Payload);
            if (string.IsNullOrWhiteSpace(nonce))
            {
                OnLog?.Invoke("[Gateway] connect.challenge missing nonce; cannot sign device identity.");
                await DisconnectAsync();
                return;
            }

            _connectParams.Auth = new Dictionary<string, object> { { "token", _token } };

            _deviceIdentity ??= _deviceIdentityService.LoadOrCreate();
            var clientId = _connectParams.Client.TryGetValue("id", out var idObj) ? (idObj?.ToString() ?? "node-host") : "node-host";
            var clientMode = _connectParams.Client.TryGetValue("mode", out var modeObj) ? (modeObj?.ToString() ?? "node") : "node";
            var role = _connectParams.Role ?? "node";
            var scopes = (_connectParams.Scopes ?? new List<string>()).ToArray();
            var signedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var payload = _deviceIdentityService.BuildDeviceAuthPayload(
                _deviceIdentity.DeviceId,
                clientId,
                clientMode,
                role,
                scopes,
                signedAt,
                _token,
                nonce);
            var signature = _deviceIdentityService.SignPayloadBase64Url(_deviceIdentity.PrivateKeyBase64Url, payload);

            _connectParams.Device = new Dictionary<string, object>
            {
                { "id", _deviceIdentity.DeviceId },
                { "publicKey", _deviceIdentity.PublicKeyBase64Url },
                { "signature", signature },
                { "signedAt", signedAt },
                { "nonce", nonce }
            };

            var connectReq = new RequestFrame
            {
                Type = "req",
                Id = Guid.NewGuid().ToString(),
                Method = "connect",
                Params = _connectParams
            };

            _pendingConnectRequestId = connectReq.Id;
            var connectJson = JsonSerializer.Serialize(connectReq, JsonOptions);
            await SendRawAsync(connectJson, cancellationToken);
        }

        private string ResolveNodeIdForInvokeResult()
        {
            if (_connectParams.Device != null &&
                _connectParams.Device.TryGetValue("id", out var idObj) &&
                idObj != null)
            {
                var id = idObj.ToString();
                if (!string.IsNullOrWhiteSpace(id))
                {
                    return id;
                }
            }

            if (_connectParams.Client.TryGetValue("id", out var clientIdObj) && clientIdObj != null)
            {
                var clientId = clientIdObj.ToString();
                if (!string.IsNullOrWhiteSpace(clientId))
                {
                    return clientId;
                }
            }

            return "node-host";
        }

        private static string? ExtractNonce(object? payload)
        {
            try
            {
                if (payload is JsonElement el &&
                    el.ValueKind == JsonValueKind.Object &&
                    el.TryGetProperty("nonce", out var nEl) &&
                    nEl.ValueKind == JsonValueKind.String)
                {
                    return nEl.GetString()?.Trim();
                }

                if (payload != null)
                {
                    using var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload, JsonOptions));
                    if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                        doc.RootElement.TryGetProperty("nonce", out var n) &&
                        n.ValueKind == JsonValueKind.String)
                    {
                        return n.GetString()?.Trim();
                    }
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private Task HandleResponseAsync(ResponseFrame res)
        {
            if (_pendingConnectRequestId != null && res.Id == _pendingConnectRequestId)
            {
                if (res.Ok)
                {
                    _backoffMs = 500;
                    _connected = true;
                    _lastTickTime = DateTime.UtcNow;

                    if (res.Payload != null)
                    {
                        try
                        {
                            var payloadJson = JsonSerializer.Serialize(res.Payload, JsonOptions);
                            var helloOk = JsonSerializer.Deserialize<HelloOkPayload>(payloadJson, JsonOptions);
                            if (helloOk?.Policy?.TickIntervalMs.HasValue == true)
                            {
                                _tickIntervalMs = helloOk.Policy.TickIntervalMs.Value;
                            }
                        }
                        catch (Exception ex)
                        {
                            OnLog?.Invoke($"[Gateway] Failed to parse hello-ok payload: {ex.Message}");
                        }
                    }

                    OnLog?.Invoke($"[Gateway] Connect accepted (hello-ok). Session established. Tick interval: {_tickIntervalMs}ms");
                    OnConnected?.Invoke();
                }
                else
                {
                    var errorText = JsonSerializer.Serialize(res.Error, JsonOptions);
                    OnLog?.Invoke($"[Gateway] Connect rejected: {errorText}");
                    OnConnectRejected?.Invoke(errorText);
                }

                _pendingConnectRequestId = null;
            }

            return Task.CompletedTask;
        }

        private async Task HandleNodeInvokeRequestAsync(EventFrame evt, CancellationToken cancellationToken)
        {
            if (evt.Payload == null) return;
            
            try
            {
                var payloadJson = JsonSerializer.Serialize(evt.Payload, JsonOptions);
                var req = JsonSerializer.Deserialize<BridgeInvokeRequest>(payloadJson, JsonOptions);
                if (req == null || OnNodeInvoke == null) return;

                OnLog?.Invoke($"[Gateway] Executing node.invoke.request id={req.Id} command={req.Command}");
                var response = await OnNodeInvoke(req);
                
                var nodeId = ResolveNodeIdForInvokeResult();
                var invokeResultReq = new RequestFrame
                {
                    Type = "req",
                    Id = Guid.NewGuid().ToString(),
                    Method = "node.invoke.result",
                    Params = new
                    {
                        id = req.Id,
                        nodeId,
                        ok = response.Ok,
                        payloadJSON = response.PayloadJSON,
                        error = response.Error
                    }
                };

                var invokeResultJson = JsonSerializer.Serialize(invokeResultReq, JsonOptions);
                await SendRawAsync(invokeResultJson, cancellationToken);
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"[Gateway] Error processing node.invoke.request: {ex.Message}");
            }
        }

        private async Task HandleRequestAsync(RequestFrame req, CancellationToken cancellationToken)
        {
            try
            {
                if (_methodHandlers.TryGetValue(req.Method, out var handler))
                {
                    var result = await handler(req);
                    await SendResponseAsync(new ResponseFrame { Type = "res", Id = req.Id, Ok = true, Payload = result }, cancellationToken);
                }
                else
                {
                    OnLog?.Invoke($"[Gateway] Unhandled method: {req.Method}");
                    await SendResponseAsync(new ResponseFrame 
                    { 
                        Type = "res",
                        Id = req.Id,
                        Ok = false,
                        Error = new { message = "Method not found", code = "INVALID_REQUEST" }
                    }, cancellationToken);
                }
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"[Gateway] Error handling method {req.Method}: {ex.Message}");
                await SendResponseAsync(new ResponseFrame 
                { 
                    Type = "res",
                    Id = req.Id,
                    Ok = false,
                    Error = new { message = ex.Message, code = "UNAVAILABLE" }
                }, cancellationToken);
            }
        }

        public async Task SendRawAsync(string message, CancellationToken cancellationToken)
        {
            await _sendLock.WaitAsync(cancellationToken);
            try
            {
                var socket = _webSocket;
                if (socket?.State != WebSocketState.Open) return;
                var bytes = Encoding.UTF8.GetBytes(message);
                await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancellationToken);
            }
            finally
            {
                _sendLock.Release();
            }
        }

        public async Task SendResponseAsync(ResponseFrame response, CancellationToken cancellationToken)
        {
            var json = JsonSerializer.Serialize(response, JsonOptions);
            await SendRawAsync(json, cancellationToken);
        }

        public async Task DisconnectAsync()
        {
            _connected = false;

            ClientWebSocket? socket;
            CancellationTokenSource? receiveCts;
            await _sendLock.WaitAsync(CancellationToken.None);
            try
            {
                socket = _webSocket;
                _webSocket = null;
                receiveCts = _activeReceiveCts;
                _activeReceiveCts = null;
                Interlocked.Increment(ref _activeReceiveGeneration);
            }
            finally
            {
                _sendLock.Release();
            }

            if (receiveCts != null)
            {
                try { receiveCts.Cancel(); } catch { }
                receiveCts.Dispose();
            }

            if (socket != null)
            {
                if (socket.State == WebSocketState.Open)
                {
                    try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None); }
                    catch { }
                }
                socket.Dispose();
                OnDisconnected?.Invoke();
            }
        }

        public void Stop()
        {
            _cts.Cancel();
        }

        public void Dispose()
        {
            _cts.Cancel();

            ClientWebSocket? socket = null;
            CancellationTokenSource? receiveCts = null;
            _sendLock.Wait();
            try
            {
                socket = _webSocket;
                _webSocket = null;
                receiveCts = _activeReceiveCts;
                _activeReceiveCts = null;
                Interlocked.Increment(ref _activeReceiveGeneration);
            }
            finally
            {
                _sendLock.Release();
            }

            if (receiveCts != null)
            {
                try { receiveCts.Cancel(); } catch { }
                receiveCts.Dispose();
            }

            socket?.Dispose();
            _sendLock.Dispose();
        }
    }
}
