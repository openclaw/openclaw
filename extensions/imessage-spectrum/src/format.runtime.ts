import { markdown } from "spectrum-ts";

export function formatSpectrumOutboundText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function buildSpectrumFormattedContent(text: string) {
  const formatted = formatSpectrumOutboundText(text);
  return markdown(formatted);
}
