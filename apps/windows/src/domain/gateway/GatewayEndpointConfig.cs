namespace OpenClawWindows.Domain.Gateway;

// typealias Config = (url: URL, token: String?, password: String?)
public sealed record GatewayEndpointConfig(Uri Url, string? Token, string? Password);
