/**
 * OCI region identifiers used to construct Generative AI endpoint hosts.
 *
 * The full OCI region table is much larger; this list is the subset where
 * Generative AI is currently served.  Cross-reference Oracle's
 * [region availability page](https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm)
 * before adding a new entry.
 *
 * Native and OpenAI-compatible endpoints share the same hostname per region
 * — the path is what differs:
 *
 *   native:           /20231130/actions/chat
 *   openai-compat:    /openai/v1/chat/completions
 */

export const OCI_GENAI_REGIONS = [
  "us-chicago-1",
  "us-ashburn-1",
  "us-phoenix-1",
  "uk-london-1",
  "eu-frankfurt-1",
  "ap-osaka-1",
  "sa-saopaulo-1",
] as const;

export type OciRegion = (typeof OCI_GENAI_REGIONS)[number];

export const DEFAULT_OCI_GENAI_REGION: OciRegion = "us-chicago-1";

export function buildOciGenAIHost(region: OciRegion): string {
  return `inference.generativeai.${region}.oci.oraclecloud.com`;
}

export function buildOciGenAINativeBaseUrl(region: OciRegion): string {
  return `https://${buildOciGenAIHost(region)}/20231130`;
}

export function buildOciGenAIOpenAIBaseUrl(region: OciRegion): string {
  return `https://${buildOciGenAIHost(region)}/openai/v1`;
}

export function isOciRegion(value: string): value is OciRegion {
  return (OCI_GENAI_REGIONS as readonly string[]).includes(value);
}
