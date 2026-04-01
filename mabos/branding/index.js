/**
 * MABOS Branding Constants
 *
 * Central location for all product-specific strings.
 * The rebrand script can regenerate the ~5 upstream file edits
 * but these constants are the canonical source of truth.
 */
export const PRODUCT_NAME = "MABOS";
export const PRODUCT_NAME_FULL = "Multi-Agent Business Operating System";
export const PRODUCT_SLUG = "mabos";
export const CLI_BIN = "mabos";
export const STATE_DIR_NAME = ".mabos";
export const CONFIG_FILENAME = "mabos.json";
export const ENV_PREFIX = "MABOS_";
/** ASCII banner for CLI startup. */
export const BANNER = `
  __  __    _    ____   ___  ____
 |  \\/  |  / \\  | __ ) / _ \\/ ___|
 | |\\/| | / _ \\ |  _ \\| | | \\___ \\
 | |  | |/ ___ \\| |_) | |_| |___) |
 |_|  |_/_/   \\_\\____/ \\___/|____/

 Multi-Agent Business Operating System
`;
/**
 * Package names the runtime should recognize as "self" when
 * resolving the installation root.
 */
export const CORE_PACKAGE_NAMES = ["openclaw", "mabos"];
//# sourceMappingURL=index.js.map
