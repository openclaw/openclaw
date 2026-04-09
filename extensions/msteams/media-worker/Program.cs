using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Graph.Communications.Calls;
using Microsoft.Graph.Communications.Client;
using Microsoft.Graph.Communications.Common;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Graph.Communications.Resources;
using Microsoft.Skype.Bots.Media;
using OpenClaw.MsTeams.Voice;

// ── CLI argument parsing ────────────────────────────────────────────────

int grpcPort = 9442;
int mediaPort = 8445;
string? callbackUrl = null;
string? serviceFqdn = null;
int instancePublicPort = 0;
string? certThumbprint = null;
string? certPath = null;
string? appId = null;
string? appSecret = null;
string? tenantId = null;

for (int i = 0; i < args.Length; i++)
{
    string NextArg() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"Missing value for {args[i]}");

    switch (args[i])
    {
        case "--grpc-port": grpcPort = int.Parse(NextArg()); break;
        case "--media-port": mediaPort = int.Parse(NextArg()); break;
        case "--callback-url": callbackUrl = NextArg(); break;
        case "--service-fqdn": serviceFqdn = NextArg(); break;
        case "--instance-public-port": instancePublicPort = int.Parse(NextArg()); break;
        case "--cert-thumbprint": certThumbprint = NextArg(); break;
        case "--cert-path": certPath = NextArg(); break;
        case "--app-id": appId = NextArg(); break;
        case "--app-secret": appSecret = NextArg(); break;
        case "--tenant-id": tenantId = NextArg(); break;
    }
}

if (string.IsNullOrEmpty(appId) || string.IsNullOrEmpty(appSecret) || string.IsNullOrEmpty(tenantId))
{
    Console.Error.WriteLine("ERROR: --app-id, --app-secret, and --tenant-id are required.");
    return 1;
}

if (string.IsNullOrEmpty(callbackUrl))
{
    Console.Error.WriteLine("ERROR: --callback-url is required.");
    return 1;
}

if (string.IsNullOrEmpty(serviceFqdn))
{
    Console.Error.WriteLine("ERROR: --service-fqdn is required.");
    return 1;
}

// ── ASP.NET Core host setup ─────────────────────────────────────────────

var builder = WebApplication.CreateBuilder();

builder.Logging.ClearProviders();
builder.Logging.AddConsole();

builder.WebHost.ConfigureKestrel(options =>
{
    options.ListenAnyIP(grpcPort, listenOptions =>
    {
        listenOptions.Protocols = HttpProtocols.Http2;
    });
});

// ── Load TLS certificate for Media Platform ─────────────────────────────

X509Certificate2? mediaCert = null;
if (!string.IsNullOrEmpty(certPath))
{
    mediaCert = new X509Certificate2(certPath);
}
else if (!string.IsNullOrEmpty(certThumbprint))
{
    using var store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
    store.Open(OpenFlags.ReadOnly);
    var found = store.Certificates.Find(X509FindType.FindByThumbprint, certThumbprint, validOnly: false);
    mediaCert = found.Count > 0 ? found[0] : throw new InvalidOperationException($"Certificate with thumbprint {certThumbprint} not found.");
}

if (mediaCert == null)
{
    Console.Error.WriteLine("ERROR: Either --cert-path or --cert-thumbprint is required for media platform.");
    return 1;
}

// ── Graph Communications stateful client ────────────────────────────────

var graphLogger = new GraphLogger("TeamsMediaWorker");

var mediaPlatformSettings = new MediaPlatformSettings
{
    MediaPlatformInstanceSettings = new MediaPlatformInstanceSettings
    {
        CertificateThumbprint = mediaCert.Thumbprint,
        InstanceInternalPort = mediaPort,
        InstancePublicIPAddress = System.Net.IPAddress.Any,
        InstancePublicPort = instancePublicPort > 0 ? instancePublicPort : mediaPort,
        ServiceFqdn = serviceFqdn,
    },
    ApplicationId = appId,
};

var authProvider = new Microsoft.Graph.Communications.Client.Authentication.AuthenticationProvider(
    appId,
    appSecret,
    graphLogger);

var communicationsClientBuilder = new CommunicationsClientBuilder("TeamsMediaWorker", graphLogger);
communicationsClientBuilder.SetAuthenticationProvider(authProvider);
communicationsClientBuilder.SetNotificationUrl(new Uri(callbackUrl));
communicationsClientBuilder.SetMediaPlatformSettings(mediaPlatformSettings);
communicationsClientBuilder.SetServiceBaseUrl(new Uri(callbackUrl));

ICommunicationsClient commsClient = communicationsClientBuilder.Build();

// ── Register services ───────────────────────────────────────────────────

var workerRegistry = new WorkerRegistry();
builder.Services.AddSingleton(workerRegistry);
builder.Services.AddSingleton(commsClient);

var callHandler = new CallHandler(
    commsClient,
    workerRegistry,
    builder.Services.BuildServiceProvider().GetRequiredService<ILoggerFactory>());

builder.Services.AddSingleton(callHandler);
builder.Services.AddGrpc();

var app = builder.Build();
app.MapGrpcService<BridgeService>();

var logger = app.Services.GetRequiredService<ILogger<Program>>();
logger.LogInformation(
    "TeamsMediaWorker starting — gRPC on port {GrpcPort}, media on port {MediaPort}, callback {Callback}",
    grpcPort, mediaPort, callbackUrl);
logger.LogInformation(
    "App ID: {AppId}, Tenant: {TenantId}, FQDN: {Fqdn}",
    appId, tenantId, serviceFqdn);

app.Run();
return 0;
