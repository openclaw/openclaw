import { Type } from "typebox";

// Flattened object schema — same pattern as browser extension.
// Claude API on Vertex AI rejects nested anyOf/union schemas, so all
// action-specific fields are optional on a single flat object and the
// runtime uses `action` as the discriminator.
export const ComputerToolSchema = Type.Object({
  action: Type.String({
    description: [
      "screenshot — capture the frontmost window of an app.",
      "get_app_state — AX tree + screenshot for an app, addressed by name.",
      "list_windows — enumerate all on-screen windows.",
      "list_apps — enumerate running and installed macOS apps.",
      "launch_app — launch an app in the background without stealing focus.",
      "click — left-click by element index or pixel coordinate.",
      "double_click — double-click.",
      "right_click — right-click.",
      "scroll — scroll by direction and amount.",
      "type — insert text via AX attribute write (fast, no key events).",
      "type_chars — type text character-by-character via CGEvent (works in web inputs).",
      "key — press a single key.",
      "hotkey — press a key combination, e.g. cmd+s.",
      "set_value — set a value on a select/popup or slider element.",
      "execute_javascript — run JS in the active browser tab (Chrome, Safari, Electron) and return the result.",
      "get_text — get the full text content of the active browser page.",
      "query_dom — query DOM elements by CSS selector and return their attributes.",
      "enable_javascript_apple_events — one-time opt-in to allow JS execution via Apple Events; ask the user before calling.",
    ].join(" "),
  }),

  // ── screenshot / get_app_state / launch_app ─────────────────────────
  app_name: Type.Optional(
    Type.String({ description: "App name for screenshot, get_app_state, or launch_app." }),
  ),
  bundle_id: Type.Optional(
    Type.String({
      description:
        "App bundle ID for launch_app (e.g. com.apple.calculator) or browser bundle ID for enable_javascript_apple_events (e.g. com.google.Chrome).",
    }),
  ),

  // ── get_app_state / get_window_state ────────────────────────────────
  pid: Type.Optional(Type.Integer({ description: "Process ID (from list_windows or list_apps)." })),
  window_id: Type.Optional(
    Type.Integer({ description: "CGWindowID (from list_windows or launch_app)." }),
  ),
  query: Type.Optional(
    Type.String({ description: "Case-insensitive substring filter for the AX tree." }),
  ),

  // ── click / double_click / right_click / scroll ──────────────────────
  element_index: Type.Optional(
    Type.Integer({
      description: "Element index from the last get_app_state / get_window_state call.",
    }),
  ),
  x: Type.Optional(Type.Number({ description: "X pixel coordinate in window-local space." })),
  y: Type.Optional(Type.Number({ description: "Y pixel coordinate in window-local space." })),
  modifier: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Modifier keys for click, e.g. ["cmd", "shift"].',
    }),
  ),

  // ── scroll ───────────────────────────────────────────────────────────
  direction: Type.Optional(
    Type.String({ description: "Scroll direction: up, down, left, right." }),
  ),
  amount: Type.Optional(Type.Integer({ description: "Scroll ticks. Default 3." })),

  // ── type / type_chars ────────────────────────────────────────────────
  text: Type.Optional(Type.String({ description: "Text to type." })),

  // ── key / hotkey ─────────────────────────────────────────────────────
  key: Type.Optional(Type.String({ description: "Key name for the key action, e.g. return." })),
  keys: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Key names for hotkey, e.g. ["cmd", "s"].',
    }),
  ),

  // ── set_value ────────────────────────────────────────────────────────
  value: Type.Optional(
    Type.String({ description: "Value for set_value — option label or numeric string." }),
  ),

  // ── page (browser JS) ────────────────────────────────────────────────
  javascript: Type.Optional(
    Type.String({
      description:
        "JS to execute (get_app_state inline or page action=execute_javascript). Wrap in IIFE: `(() => { ... })()`.",
    }),
  ),
  css_selector: Type.Optional(
    Type.String({ description: "CSS selector for page action=query_dom." }),
  ),
  attributes: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Element attributes to include per match for query_dom. tag and innerText always included.",
    }),
  ),
  user_has_confirmed_enabling: Type.Optional(
    Type.Boolean({
      description:
        "Must be true for page action=enable_javascript_apple_events. Ask the user first.",
    }),
  ),
});

export type ComputerToolParams = {
  action: string;
  app_name?: string;
  bundle_id?: string;
  pid?: number;
  window_id?: number;
  query?: string;
  element_index?: number;
  x?: number;
  y?: number;
  modifier?: string[];
  direction?: string;
  amount?: number;
  text?: string;
  key?: string;
  keys?: string[];
  value?: string;
  javascript?: string;
  css_selector?: string;
  attributes?: string[];
  user_has_confirmed_enabling?: boolean;
};
