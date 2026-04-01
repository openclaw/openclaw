/**
 * MABOS Branding Constants
 *
 * Central location for all product-specific strings.
 * The rebrand script can regenerate the ~5 upstream file edits
 * but these constants are the canonical source of truth.
 */
export declare const PRODUCT_NAME = "MABOS";
export declare const PRODUCT_NAME_FULL = "Multi-Agent Business Operating System";
export declare const PRODUCT_SLUG = "mabos";
export declare const CLI_BIN = "mabos";
export declare const STATE_DIR_NAME = ".mabos";
export declare const CONFIG_FILENAME = "mabos.json";
export declare const ENV_PREFIX = "MABOS_";
/** ASCII banner for CLI startup. */
export declare const BANNER =
  "\n  __  __    _    ____   ___  ____\n |  \\/  |  / \\  | __ ) / _ \\/ ___|\n | |\\/| | / _ \\ |  _ \\| | | \\___ \\\n | |  | |/ ___ \\| |_) | |_| |___) |\n |_|  |_/_/   \\_\\____/ \\___/|____/\n\n Multi-Agent Business Operating System\n";
/**
 * Package names the runtime should recognize as "self" when
 * resolving the installation root.
 */
export declare const CORE_PACKAGE_NAMES: readonly ["openclaw", "mabos"];
//# sourceMappingURL=index.d.ts.map
