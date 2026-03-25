using System.Text.Json.Serialization;

namespace OpenClawWindows.Infrastructure.Pairing;

// Gateway protocol DTOs for device and node pairing.
// Field names mirror the JSON schema used by the gateway (camelCase).

internal sealed record DevicePendingRequest(
    [property: JsonPropertyName("requestId")]  string  RequestId,
    [property: JsonPropertyName("deviceId")]   string  DeviceId,
    [property: JsonPropertyName("displayName")] string? DisplayName,
    [property: JsonPropertyName("platform")]   string? Platform,
    [property: JsonPropertyName("role")]       string? Role,
    [property: JsonPropertyName("scopes")]     string[]? Scopes,
    [property: JsonPropertyName("remoteIp")]   string? RemoteIp,
    [property: JsonPropertyName("silent")]     bool?   Silent,
    [property: JsonPropertyName("isRepair")]   bool?   IsRepair,
    [property: JsonPropertyName("ts")]         double  Ts);

internal sealed record DevicePairedEntry(
    [property: JsonPropertyName("deviceId")]    string  DeviceId,
    [property: JsonPropertyName("approvedAtMs")] double? ApprovedAtMs,
    [property: JsonPropertyName("displayName")] string? DisplayName,
    [property: JsonPropertyName("platform")]    string? Platform,
    [property: JsonPropertyName("remoteIp")]    string? RemoteIp);

internal sealed record DevicePairingList(
    [property: JsonPropertyName("pending")] DevicePendingRequest[] Pending,
    [property: JsonPropertyName("paired")]  DevicePairedEntry[]?   Paired);

internal sealed record NodePendingRequest(
    [property: JsonPropertyName("requestId")]  string  RequestId,
    [property: JsonPropertyName("nodeId")]     string  NodeId,
    [property: JsonPropertyName("displayName")] string? DisplayName,
    [property: JsonPropertyName("platform")]   string? Platform,
    [property: JsonPropertyName("version")]    string? Version,
    [property: JsonPropertyName("remoteIp")]   string? RemoteIp,
    [property: JsonPropertyName("silent")]     bool?   Silent,
    [property: JsonPropertyName("isRepair")]   bool?   IsRepair,
    [property: JsonPropertyName("ts")]         double  Ts);

internal sealed record NodePairedEntry(
    [property: JsonPropertyName("nodeId")]      string  NodeId,
    [property: JsonPropertyName("approvedAtMs")] double? ApprovedAtMs,
    [property: JsonPropertyName("displayName")] string? DisplayName,
    [property: JsonPropertyName("platform")]    string? Platform,
    [property: JsonPropertyName("version")]     string? Version,
    [property: JsonPropertyName("remoteIp")]    string? RemoteIp);

internal sealed record NodePairingList(
    [property: JsonPropertyName("pending")] NodePendingRequest[] Pending,
    [property: JsonPropertyName("paired")]  NodePairedEntry[]?   Paired);

internal sealed record PairingResolvedEvent(
    [property: JsonPropertyName("requestId")] string RequestId,
    [property: JsonPropertyName("decision")]  string Decision);
