declare module "tokenjuice/openclaw" {
  import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

  export function createTokenjuiceOpenClawEmbeddedExtension(): ExtensionFactory;
}
