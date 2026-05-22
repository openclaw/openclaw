import type { InstalledPluginIndex, InstalledPluginIndexRefreshReason } from "./installed-plugin-index-types.js";
export declare function diffInstalledPluginIndexInvalidationReasons(previous: InstalledPluginIndex, current: InstalledPluginIndex): readonly InstalledPluginIndexRefreshReason[];
