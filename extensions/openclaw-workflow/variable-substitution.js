/**
 * @module variable-substitution
 * @description Performs template variable substitution on workflow task prompts,
 * output file paths, and any other string fields in a workflow definition.
 *
 * Supported variables:
 *   {date}     → Current date in YYYY-MM-DD format (UTC)
 *   {datetime} → Current datetime as full ISO 8601 string (e.g. 2026-03-09T14:22:00.000Z)
 *   {run_id}   → The unique run identifier for this workflow execution
 *
 * Why UTC? Workflows often run on servers without a specific timezone configuration.
 * Using UTC ensures consistent, reproducible filenames and logs regardless of the
 * server's locale. If local time is needed, that's a future extension point.
 *
 * Dependencies: none (pure Node.js)
 *
 * @example
 * import { substituteVars, buildContext } from './variable-substitution.js';
 * const ctx = buildContext('my-pipeline-20260309T082000');
 * const path = substituteVars('data/output-{date}.json', ctx);
 * // → 'data/output-2026-03-09.json'
 */

/**
 * @typedef {Object} SubstitutionContext
 * @property {string} date     - Current date as YYYY-MM-DD (UTC)
 * @property {string} datetime - Current datetime as ISO 8601 string
 * @property {string} run_id   - The workflow run identifier
 */

/**
 * Build a substitution context object for a given run.
 * Snapshot the current time once so all substitutions within a run are consistent.
 *
 * @param {string} runId - The workflow run ID
 * @param {Date} [now=new Date()] - Optional fixed timestamp (useful for testing)
 * @returns {SubstitutionContext}
 *
 * @example
 * const ctx = buildContext('seo-pipeline-2026-03-09T082000');
 * // ctx.date === '2026-03-09'
 * // ctx.datetime === '2026-03-09T08:20:00.000Z'  (approx)
 * // ctx.run_id === 'seo-pipeline-2026-03-09T082000'
 */
export function buildContext(runId, now = new Date()) {
  const isoString = now.toISOString();
  // Extract YYYY-MM-DD from the ISO string prefix
  const date = isoString.slice(0, 10);

  return {
    date,
    datetime: isoString,
    run_id: runId,
  };
}

/**
 * Replace all {variable} placeholders in a string using the given context.
 * Unknown placeholders are left unchanged (not treated as errors) so that
 * workflow authors can use braces for other purposes in their task prompts
 * without breaking substitution.
 *
 * @param {string} template - String containing zero or more {variable} placeholders
 * @param {SubstitutionContext} ctx - Context object supplying variable values
 * @returns {string} The template with all known variables replaced
 *
 * @example
 * const ctx = buildContext('my-run');
 * substituteVars('Audit output: data/{date}/results.json', ctx);
 * // → 'Audit output: data/2026-03-09/results.json'
 *
 * // Unknown variables are passed through:
 * substituteVars('Hello {name}, run={run_id}', ctx);
 * // → 'Hello {name}, run=my-run'
 */
export function substituteVars(template, ctx) {
  if (typeof template !== 'string') return template;

  // Replace all {key} tokens where key is a known context variable.
  // The regex captures the inner key so we can look it up in ctx.
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    // Only replace if the key exists in ctx; leave unknown tokens as-is
    return Object.prototype.hasOwnProperty.call(ctx, key) ? ctx[key] : match;
  });
}

/**
 * Recursively apply substituteVars to all string values in an object or array.
 * This is used to substitute variables throughout an entire step definition
 * (task prompt, output paths, etc.) in one pass.
 *
 * Non-string primitives (numbers, booleans) and null/undefined are returned as-is.
 * Arrays are mapped. Plain objects are shallow-cloned with each value processed.
 *
 * @param {*} value - The value to process (string, array, object, or primitive)
 * @param {SubstitutionContext} ctx - Substitution context
 * @returns {*} A new value with all string leaves substituted
 *
 * @example
 * const step = {
 *   task: "Run audit for {date}",
 *   outputs: ["data/{date}/handoff.json"]
 * };
 * const result = substituteDeep(step, ctx);
 * // result.task === "Run audit for 2026-03-09"
 * // result.outputs === ["data/2026-03-09/handoff.json"]
 */
export function substituteDeep(value, ctx) {
  if (typeof value === 'string') {
    return substituteVars(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map(item => substituteDeep(item, ctx));
  }
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substituteDeep(v, ctx);
    }
    return result;
  }
  // Primitives (number, boolean, null, undefined) pass through unchanged
  return value;
}
