import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

declare module "tokenjuice/openclaw" {
  export function createTokenjuiceOpenClawEmbeddedExtension(): ExtensionFactory;
}
