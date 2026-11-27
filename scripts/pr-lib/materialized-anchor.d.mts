import type { AnchorIdentity } from "./cache-lifetime.mjs";
export declare function claimMaterializedAnchor(
  script: string,
  creatorPid?: number,
): AnchorIdentity | undefined;
export declare function retireMaterializedAnchor(anchor: AnchorIdentity | undefined): void;
