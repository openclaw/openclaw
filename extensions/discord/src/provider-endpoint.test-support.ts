const DISCORD_PROVIDER_ENDPOINT_ENV = "DISCORD_PROVIDER_ENDPOINT";

type DiscordProviderEndpointDescriptor = Readonly<{
  restApiBaseUrl: string;
  gatewayBotUrl: string;
  gatewayOrigin: string;
}>;

export async function initializeDiscordProviderEndpointForTest(
  descriptor: DiscordProviderEndpointDescriptor,
): Promise<void> {
  const { initializeDiscordProviderEndpointFromEnv } = await import("./provider-endpoint.js");
  initializeDiscordProviderEndpointFromEnv({
    [DISCORD_PROVIDER_ENDPOINT_ENV]: JSON.stringify(descriptor),
  });
}
