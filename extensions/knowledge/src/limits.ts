/** Durable UTF-8 record bytes, including frontmatter; not a transport allowance. */
export const RECORD_MAX_BYTES = 5_000_000;
/** Ontology, manifests and inline source files keep their independent bound. */
export const AUXILIARY_MAX_BYTES = 65_536;
/** A single authored body/replacement is bounded; edits can grow larger records. */
export const BODY_INPUT_MAX_CHARS = 48_000;
/** Maximum requested text window; complete JSON budgets may reduce it further. */
export const TEXT_PAGE_MAX_CHARS = 65_536;
export const TEXT_PAGE_DEFAULT_CHARS = 12_000;
/** Whole record-inspection response budget, including metadata and navigation. */
export const RECORD_RESPONSE_MAX_BYTES = 24 * 1024;
/** Bound SQLite full-document highlight work independently of matching/ranking. */
export const SEARCH_HIGHLIGHT_MAX_BYTES = 65_536;
