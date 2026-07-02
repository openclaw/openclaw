// Keep config validation and REST routing on the same closed set of supported Regions.
export const TWILIO_REGIONS = ["us1", "ie1", "au1"] as const;
export type TwilioRegion = (typeof TWILIO_REGIONS)[number];

const TWILIO_API_HOSTNAME_BY_REGION = {
  us1: "api.twilio.com",
  ie1: "api.dublin.ie1.twilio.com",
  au1: "api.sydney.au1.twilio.com",
} satisfies Record<TwilioRegion, string>;

export function resolveTwilioApiHostname(region: TwilioRegion = "us1"): string {
  return TWILIO_API_HOSTNAME_BY_REGION[region];
}
