using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using OpenClaw.Node.Protocol;

namespace OpenClaw.Node.Services
{
    public class CoreMethodService
    {
        private readonly DateTimeOffset _startedAtUtc;
        private readonly ConcurrentDictionary<string, PairRequest> _pendingPairRequests = new();
        private readonly object _pendingPairGate = new();
        private readonly string _pendingPairCachePath;

        public bool HeartbeatsEnabled { get; private set; } = true;
        public int PendingPairCount => _pendingPairRequests.Count;

        public CoreMethodService(DateTimeOffset startedAtUtc, string? pendingPairCachePath = null)
        {
            _startedAtUtc = startedAtUtc;
            _pendingPairCachePath = ResolvePendingPairCachePath(pendingPairCachePath);
            LoadPendingPairRequests();
        }

        public Task<object?> HandleStatusAsync(RequestFrame _)
        {
            var uptimeSeconds = (long)(DateTimeOffset.UtcNow - _startedAtUtc).TotalSeconds;
            return Task.FromResult<object?>(new
            {
                ok = true,
                status = "online",
                uptimeSeconds,
                platform = "windows",
                clientId = "node-host",
                heartbeatsEnabled = HeartbeatsEnabled
            });
        }

        public Task<object?> HandleHealthAsync(RequestFrame _)
        {
            return Task.FromResult<object?>(new
            {
                ok = true,
                checks = new { websocket = true, protocol = Constants.GatewayProtocolVersion }
            });
        }

        public Task<object?> HandleSetHeartbeatsAsync(RequestFrame req)
        {
            var enabled = TryGetBool(req.Params, "enabled");
            if (enabled.HasValue) HeartbeatsEnabled = enabled.Value;
            return Task.FromResult<object?>(new { ok = true, enabled = HeartbeatsEnabled });
        }

        public Task<object?> HandleSystemEventAsync(RequestFrame _)
        {
            return Task.FromResult<object?>(new { ok = true });
        }

        public Task<object?> HandleChannelsStatusAsync(RequestFrame _)
        {
            return Task.FromResult<object?>(new
            {
                ok = true,
                channels = Array.Empty<object>()
            });
        }

        public Task<object?> HandleConfigGetAsync(RequestFrame _)
        {
            return Task.FromResult<object?>(new
            {
                ok = true,
                config = new
                {
                    heartbeatsEnabled = HeartbeatsEnabled,
                    node = new { platform = "windows", role = "node" }
                }
            });
        }

        public Task<object?> HandleConfigSchemaAsync(RequestFrame _)
        {
            return Task.FromResult<object?>(new
            {
                ok = true,
                schema = new
                {
                    type = "object",
                    properties = new
                    {
                        heartbeatsEnabled = new { type = "boolean" }
                    },
                    additionalProperties = true
                }
            });
        }

        public Task<object?> HandleConfigSetAsync(RequestFrame req)
        {
            if (req.Params is JsonElement el && el.ValueKind == JsonValueKind.Object)
            {
                JsonElement cfg = el;
                if (el.TryGetProperty("config", out var cfgEl) && cfgEl.ValueKind == JsonValueKind.Object)
                {
                    cfg = cfgEl;
                }

                if (cfg.TryGetProperty("heartbeatsEnabled", out var hb) && hb.ValueKind is JsonValueKind.True or JsonValueKind.False)
                {
                    HeartbeatsEnabled = hb.GetBoolean();
                }
            }

            return Task.FromResult<object?>(new { ok = true, config = new { heartbeatsEnabled = HeartbeatsEnabled } });
        }

        public Task<object?> HandleConfigPatchAsync(RequestFrame req)
        {
            if (req.Params is JsonElement el && el.ValueKind == JsonValueKind.Object)
            {
                JsonElement patch = el;
                if (el.TryGetProperty("patch", out var patchEl) && patchEl.ValueKind == JsonValueKind.Object)
                {
                    patch = patchEl;
                }

                if (patch.TryGetProperty("heartbeatsEnabled", out var hb) && hb.ValueKind is JsonValueKind.True or JsonValueKind.False)
                {
                    HeartbeatsEnabled = hb.GetBoolean();
                }
            }

            return Task.FromResult<object?>(new { ok = true, applied = new { heartbeatsEnabled = HeartbeatsEnabled } });
        }

        // ---------- Pairing methods (Phase 1)

        public bool HandleGatewayEvent(EventFrame evt)
        {
            if (evt.Payload is not JsonElement payload || payload.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            if (evt.Event == "device.pair.requested")
            {
                var requestId = TryGetString(payload, "requestId");
                if (payload.TryGetProperty("requestId", out var r) && r.ValueKind == JsonValueKind.String)
                {
                    requestId = r.GetString();
                }

                var label = TryGetString(payload, "displayName") ?? TryGetString(payload, "deviceId");
                if (!string.IsNullOrWhiteSpace(requestId))
                {
                    AddPendingPairRequest(requestId!, label, "device");
                    return true;
                }
                return false;
            }

            if (evt.Event == "node.pair.requested")
            {
                var requestId = TryGetString(payload, "requestId");
                var label = TryGetString(payload, "displayName") ?? TryGetString(payload, "nodeId");
                if (!string.IsNullOrWhiteSpace(requestId))
                {
                    AddPendingPairRequest(requestId!, label, "node");
                    return true;
                }
                return false;
            }

            if (evt.Event == "device.pair.resolved" || evt.Event == "node.pair.resolved")
            {
                var requestId = TryGetString(payload, "requestId");
                if (!string.IsNullOrWhiteSpace(requestId))
                {
                    lock (_pendingPairGate)
                    {
                        if (_pendingPairRequests.TryRemove(requestId!, out _))
                        {
                            PersistPendingPairRequestsUnsafe();
                        }
                    }
                    return true;
                }
                return false;
            }

            return false;
        }

        public void AddPendingPairRequest(string requestId, string? deviceLabel = null, string kind = "device")
        {
            if (string.IsNullOrWhiteSpace(requestId)) return;

            lock (_pendingPairGate)
            {
                _pendingPairRequests[requestId] = new PairRequest
                {
                    RequestId = requestId,
                    DeviceLabel = string.IsNullOrWhiteSpace(deviceLabel) ? "unknown-device" : deviceLabel,
                    Kind = string.IsNullOrWhiteSpace(kind) ? "device" : kind,
                    RequestedAt = DateTimeOffset.UtcNow
                };
                PersistPendingPairRequestsUnsafe();
            }
        }

        public Task<object?> HandleDevicePairListAsync(RequestFrame _)
        {
            PairRequest[] snapshot;
            lock (_pendingPairGate)
            {
                snapshot = _pendingPairRequests.Values.ToArray();
            }

            var items = snapshot
                .Where(x => x.Kind == "device")
                .OrderByDescending(x => x.RequestedAt)
                .Select(x => new
                {
                    requestId = x.RequestId,
                    deviceLabel = x.DeviceLabel,
                    requestedAt = x.RequestedAt.ToString("O")
                })
                .ToArray();

            return Task.FromResult<object?>(new { ok = true, pending = items });
        }

        public Task<object?> HandleNodePairListAsync(RequestFrame _)
        {
            PairRequest[] snapshot;
            lock (_pendingPairGate)
            {
                snapshot = _pendingPairRequests.Values.ToArray();
            }

            var items = snapshot
                .Where(x => x.Kind == "node")
                .OrderByDescending(x => x.RequestedAt)
                .Select(x => new
                {
                    requestId = x.RequestId,
                    nodeLabel = x.DeviceLabel,
                    requestedAt = x.RequestedAt.ToString("O")
                })
                .ToArray();

            return Task.FromResult<object?>(new { ok = true, pending = items });
        }

        public Task<object?> HandleDevicePairApproveAsync(RequestFrame req) =>
            ResolvePairRequest(req, approved: true, method: "device.pair.approve");

        public Task<object?> HandleDevicePairRejectAsync(RequestFrame req) =>
            ResolvePairRequest(req, approved: false, method: "device.pair.reject");

        public Task<object?> HandleNodePairApproveAsync(RequestFrame req) =>
            ResolvePairRequest(req, approved: true, method: "node.pair.approve");

        public Task<object?> HandleNodePairRejectAsync(RequestFrame req) =>
            ResolvePairRequest(req, approved: false, method: "node.pair.reject");

        private Task<object?> ResolvePairRequest(RequestFrame req, bool approved, string method)
        {
            var requestId = TryGetString(req.Params, "requestId") ?? TryGetString(req.Params, "id");
            if (string.IsNullOrWhiteSpace(requestId))
            {
                return Task.FromResult<object?>(new
                {
                    ok = false,
                    error = $"{method} requires requestId"
                });
            }

            bool existed;
            lock (_pendingPairGate)
            {
                existed = _pendingPairRequests.TryRemove(requestId!, out _);
                if (existed)
                {
                    PersistPendingPairRequestsUnsafe();
                }
            }
            return Task.FromResult<object?>(new
            {
                ok = existed,
                requestId,
                approved,
                status = existed ? "resolved" : "not-found"
            });
        }

        private void LoadPendingPairRequests()
        {
            try
            {
                if (!File.Exists(_pendingPairCachePath))
                {
                    return;
                }

                var json = File.ReadAllText(_pendingPairCachePath);
                if (string.IsNullOrWhiteSpace(json))
                {
                    return;
                }

                var items = JsonSerializer.Deserialize<PairRequest[]>(json);
                if (items == null)
                {
                    return;
                }

                lock (_pendingPairGate)
                {
                    foreach (var item in items)
                    {
                        if (item == null || string.IsNullOrWhiteSpace(item.RequestId))
                        {
                            continue;
                        }

                        _pendingPairRequests[item.RequestId] = item;
                    }
                }
            }
            catch
            {
                // best-effort cache load; ignore corrupt/non-readable cache
            }
        }

        private void PersistPendingPairRequests()
        {
            lock (_pendingPairGate)
            {
                PersistPendingPairRequestsUnsafe();
            }
        }

        private void PersistPendingPairRequestsUnsafe()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_pendingPairCachePath)!);
                var items = _pendingPairRequests.Values
                    .OrderByDescending(x => x.RequestedAt)
                    .ToArray();
                var json = JsonSerializer.Serialize(items, new JsonSerializerOptions { WriteIndented = true }) + "\n";
                File.WriteAllText(_pendingPairCachePath, json);
            }
            catch
            {
                // best-effort cache persist
            }
        }

        private static string ResolvePendingPairCachePath(string? explicitPath)
        {
            if (!string.IsNullOrWhiteSpace(explicitPath)) return explicitPath;
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, ".openclaw", "identity", "pending-pairs.json");
        }

        private static bool? TryGetBool(object? rawParams, string key)
        {
            if (rawParams is JsonElement el && el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var value))
            {
                if (value.ValueKind == JsonValueKind.True) return true;
                if (value.ValueKind == JsonValueKind.False) return false;
            }
            return null;
        }

        private static string? TryGetString(object? rawParams, string key)
        {
            if (rawParams is JsonElement el && el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String)
            {
                return value.GetString();
            }
            return null;
        }

        private sealed class PairRequest
        {
            public string RequestId { get; set; } = string.Empty;
            public string DeviceLabel { get; set; } = "unknown-device";
            public string Kind { get; set; } = "device";
            public DateTimeOffset RequestedAt { get; set; }
        }
    }
}
