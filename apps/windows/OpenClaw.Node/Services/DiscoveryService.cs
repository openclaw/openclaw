using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using OpenClaw.Node.Protocol;

namespace OpenClaw.Node.Services
{
    public interface IDiscoveryTransport : IDisposable
    {
        Task SendAsync(string host, int port, byte[] payload, CancellationToken cancellationToken);
    }

    public sealed class UdpDiscoveryTransport : IDiscoveryTransport
    {
        private readonly UdpClient _udp = new();

        public async Task SendAsync(string host, int port, byte[] payload, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await _udp.SendAsync(payload, payload.Length, host, port);
        }

        public void Dispose() => _udp.Dispose();
    }

    public sealed record DiscoveredNode(
        string NodeId,
        string? DisplayName,
        string? Platform,
        string? Version,
        string? InstanceId,
        string? GatewayHost,
        int? GatewayPort,
        DateTimeOffset LastSeenUtc,
        DateTimeOffset? AnnouncedAtUtc);

    public sealed class DiscoveryService : IDisposable
    {
        private const string DefaultMulticastHost = "239.255.77.77";
        private const int DefaultMulticastPort = 18791;

        private readonly ConnectParams _connectParams;
        private readonly Uri _gatewayUri;
        private readonly IDiscoveryTransport _transport;
        private readonly Func<DateTimeOffset> _clock;
        private readonly Func<int, int> _nextJitterMs;
        private readonly TimeSpan _interval;
        private readonly TimeSpan _staleAfter;
        private readonly TimeSpan _minAnnounceGap;
        private readonly string _multicastHost;
        private readonly int _multicastPort;
        private readonly string? _selfInstanceId;
        private readonly bool _enableListener;

        private readonly ConcurrentDictionary<string, DiscoveredNode> _knownNodes = new();
        private readonly SemaphoreSlim _announceGate = new(1, 1);

        private CancellationTokenSource? _loopCts;
        private Task? _announceLoopTask;
        private Task? _listenLoopTask;
        private DateTimeOffset _lastAnnounceAt = DateTimeOffset.MinValue;
        private bool _networkChangeSubscribed;

        public event Action<string>? OnLog;

        public DiscoveryService(
            ConnectParams connectParams,
            string gatewayUrl,
            IDiscoveryTransport? transport = null,
            TimeSpan? interval = null,
            TimeSpan? staleAfter = null,
            TimeSpan? minAnnounceGap = null,
            Func<DateTimeOffset>? clock = null,
            Func<int, int>? nextJitterMs = null,
            string multicastHost = DefaultMulticastHost,
            int multicastPort = DefaultMulticastPort,
            bool enableListener = true)
        {
            _connectParams = connectParams;
            _gatewayUri = new Uri(gatewayUrl);
            _transport = transport ?? new UdpDiscoveryTransport();
            _clock = clock ?? (() => DateTimeOffset.UtcNow);
            _nextJitterMs = nextJitterMs ?? (maxExclusive => maxExclusive <= 0 ? 0 : Random.Shared.Next(0, maxExclusive));
            _interval = interval ?? TimeSpan.FromSeconds(30);
            _staleAfter = staleAfter ?? TimeSpan.FromSeconds(95);
            _minAnnounceGap = minAnnounceGap ?? TimeSpan.FromSeconds(2);
            _multicastHost = string.IsNullOrWhiteSpace(multicastHost) ? DefaultMulticastHost : multicastHost;
            _multicastPort = multicastPort > 0 ? multicastPort : DefaultMulticastPort;
            _selfInstanceId = GetClientString(_connectParams.Client, "instanceId");
            _enableListener = enableListener;
        }

        public void Start(CancellationToken cancellationToken)
        {
            if (_announceLoopTask != null || _listenLoopTask != null) return;

            _loopCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            SubscribeNetworkChangeEvents();
            _announceLoopTask = Task.Run(() => RunAnnounceLoopAsync(_loopCts.Token), _loopCts.Token);
            if (_enableListener)
            {
                _listenLoopTask = Task.Run(() => RunListenLoopAsync(_loopCts.Token), _loopCts.Token);
            }
        }

        public async Task StopAsync()
        {
            if (_loopCts == null) return;

            _loopCts.Cancel();

            try
            {
                if (_announceLoopTask != null) await _announceLoopTask;
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                OnLog?.Invoke($"[DISCOVERY] announce loop stop error: {ex.Message}");
            }

            try
            {
                if (_listenLoopTask != null) await _listenLoopTask;
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                OnLog?.Invoke($"[DISCOVERY] listen loop stop error: {ex.Message}");
            }
            finally
            {
                UnsubscribeNetworkChangeEvents();
                _loopCts.Dispose();
                _loopCts = null;
                _announceLoopTask = null;
                _listenLoopTask = null;
            }
        }

        public async Task AnnounceOnceAsync(CancellationToken cancellationToken)
        {
            await AnnounceInternalAsync(reason: "manual", bypassGap: true, cancellationToken);
        }

        public async Task TriggerAnnounceAsync(string reason, CancellationToken cancellationToken)
        {
            await AnnounceInternalAsync(reason, bypassGap: false, cancellationToken);
        }

        public IReadOnlyList<DiscoveredNode> GetKnownNodesSnapshot()
        {
            PurgeStaleNodes();
            return _knownNodes.Values
                .OrderBy(x => x.DisplayName ?? x.NodeId, StringComparer.OrdinalIgnoreCase)
                .ThenBy(x => x.NodeId, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        public int PurgeStaleNodes()
        {
            var now = _clock();
            var removed = 0;
            foreach (var item in _knownNodes)
            {
                if (now - item.Value.LastSeenUtc > _staleAfter)
                {
                    if (_knownNodes.TryRemove(item.Key, out _)) removed++;
                }
            }
            return removed;
        }

        public void HandleBeaconJson(string json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                if (!root.TryGetProperty("schema", out var schemaEl) || schemaEl.GetString() != "openclaw.node.discovery.v1")
                    return;

                if (!root.TryGetProperty("nodeId", out var nodeIdEl))
                    return;

                var nodeId = nodeIdEl.GetString();
                if (string.IsNullOrWhiteSpace(nodeId))
                    return;

                var instanceId = root.TryGetProperty("instanceId", out var instanceEl) ? instanceEl.GetString() : null;
                if (!string.IsNullOrWhiteSpace(_selfInstanceId) && string.Equals(instanceId, _selfInstanceId, StringComparison.Ordinal))
                    return; // Ignore self-beacons.

                DateTimeOffset? announcedAt = null;
                if (root.TryGetProperty("announcedAt", out var announcedAtEl) && announcedAtEl.ValueKind == JsonValueKind.String)
                {
                    if (DateTimeOffset.TryParse(announcedAtEl.GetString(), out var parsed))
                        announcedAt = parsed;
                }

                string? gatewayHost = null;
                int? gatewayPort = null;
                if (root.TryGetProperty("gateway", out var gw) && gw.ValueKind == JsonValueKind.Object)
                {
                    gatewayHost = gw.TryGetProperty("host", out var hostEl) ? hostEl.GetString() : null;
                    gatewayPort = gw.TryGetProperty("port", out var portEl) && portEl.ValueKind == JsonValueKind.Number
                        ? portEl.GetInt32()
                        : null;
                }

                var discovered = new DiscoveredNode(
                    NodeId: nodeId,
                    DisplayName: root.TryGetProperty("displayName", out var dn) ? dn.GetString() : null,
                    Platform: root.TryGetProperty("platform", out var pf) ? pf.GetString() : null,
                    Version: root.TryGetProperty("version", out var ve) ? ve.GetString() : null,
                    InstanceId: instanceId,
                    GatewayHost: gatewayHost,
                    GatewayPort: gatewayPort,
                    LastSeenUtc: _clock(),
                    AnnouncedAtUtc: announcedAt);

                _knownNodes[nodeId] = discovered;
            }
            catch
            {
                // Ignore malformed beacon payloads.
            }
        }

        internal object BuildBeaconPayload()
        {
            var client = _connectParams.Client;
            var nodeId = GetClientString(client, "id") ?? "node-host";
            var displayName = GetClientString(client, "displayName") ?? Environment.MachineName;
            var platform = GetClientString(client, "platform") ?? "windows";
            var version = GetClientString(client, "version") ?? "dev";
            var instanceId = GetClientString(client, "instanceId");

            return new
            {
                schema = "openclaw.node.discovery.v1",
                nodeId,
                displayName,
                platform,
                mode = "node",
                version,
                instanceId,
                gateway = new
                {
                    scheme = _gatewayUri.Scheme,
                    host = _gatewayUri.Host,
                    port = _gatewayUri.Port
                },
                capabilities = _connectParams.Caps ?? new List<string>(),
                commands = _connectParams.Commands ?? new List<string>(),
                announcedAt = _clock().UtcDateTime.ToString("O")
            };
        }

        private async Task AnnounceInternalAsync(string reason, bool bypassGap, CancellationToken cancellationToken)
        {
            await _announceGate.WaitAsync(cancellationToken);
            try
            {
                var now = _clock();
                if (!bypassGap && now - _lastAnnounceAt < _minAnnounceGap)
                {
                    return;
                }

                var payloadJson = JsonSerializer.Serialize(BuildBeaconPayload(), new JsonSerializerOptions
                {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                });

                var bytes = Encoding.UTF8.GetBytes(payloadJson);
                await _transport.SendAsync(_multicastHost, _multicastPort, bytes, cancellationToken);
                _lastAnnounceAt = now;
                OnLog?.Invoke($"[DISCOVERY] Beacon announced ({reason}) -> {_multicastHost}:{_multicastPort}");
            }
            finally
            {
                _announceGate.Release();
            }
        }

        private async Task RunAnnounceLoopAsync(CancellationToken cancellationToken)
        {
            await AnnounceInternalAsync(reason: "startup", bypassGap: true, cancellationToken);

            while (!cancellationToken.IsCancellationRequested)
            {
                var jitterMs = _nextJitterMs(3000);
                var wait = _interval + TimeSpan.FromMilliseconds(jitterMs);
                await Task.Delay(wait, cancellationToken);

                var removed = PurgeStaleNodes();
                if (removed > 0)
                {
                    OnLog?.Invoke($"[DISCOVERY] Purged {removed} stale discovery entr{(removed == 1 ? "y" : "ies")}");
                }

                await AnnounceInternalAsync(reason: "periodic", bypassGap: true, cancellationToken);
            }
        }

        private async Task RunListenLoopAsync(CancellationToken cancellationToken)
        {
            UdpClient? listener = null;
            try
            {
                listener = new UdpClient(AddressFamily.InterNetwork);
                listener.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                listener.Client.Bind(new IPEndPoint(IPAddress.Any, _multicastPort));
                listener.JoinMulticastGroup(IPAddress.Parse(_multicastHost));

                while (!cancellationToken.IsCancellationRequested)
                {
                    var result = await listener.ReceiveAsync(cancellationToken);
                    var json = Encoding.UTF8.GetString(result.Buffer);
                    HandleBeaconJson(json);
                }
            }
            catch (OperationCanceledException)
            {
                // expected on shutdown
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"[DISCOVERY] Listener unavailable: {ex.Message}");
            }
            finally
            {
                listener?.Dispose();
            }
        }

        private void SubscribeNetworkChangeEvents()
        {
            if (_networkChangeSubscribed) return;
            NetworkChange.NetworkAddressChanged += OnNetworkAddressChanged;
            _networkChangeSubscribed = true;
        }

        private void UnsubscribeNetworkChangeEvents()
        {
            if (!_networkChangeSubscribed) return;
            NetworkChange.NetworkAddressChanged -= OnNetworkAddressChanged;
            _networkChangeSubscribed = false;
        }

        private void OnNetworkAddressChanged(object? sender, EventArgs e)
        {
            if (_loopCts == null || _loopCts.IsCancellationRequested) return;

            _ = Task.Run(async () =>
            {
                try
                {
                    await TriggerAnnounceAsync("network-change", _loopCts.Token);
                }
                catch (Exception ex)
                {
                    OnLog?.Invoke($"[DISCOVERY] network-change announce failed: {ex.Message}");
                }
            });
        }

        private static string? GetClientString(Dictionary<string, object>? client, string key)
        {
            if (client == null) return null;
            if (!client.TryGetValue(key, out var value) || value == null) return null;
            var text = value.ToString();
            return string.IsNullOrWhiteSpace(text) ? null : text;
        }

        public void Dispose()
        {
            try
            {
                StopAsync().GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"[DISCOVERY] dispose stop error: {ex.Message}");
            }

            _announceGate.Dispose();
            _transport.Dispose();
        }
    }
}
