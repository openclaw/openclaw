// src/zed-theme.ts
import type { Roles } from "./palette";

type ZedHighlightStyle = {
  color?: string;
  background_color?: string;
  font_style?: "normal" | "italic" | "oblique";
  font_weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
};

type ZedPlayerColor = {
  cursor?: string;
  background?: string;
  selection?: string;
};

type ZedThemeStyle = {
  // Backgrounds
  background: string;
  "background.appearance"?: "opaque" | "transparent" | "blurred";
  "surface.background": string;
  "elevated_surface.background": string;
  "drop_target.background": string;

  // Editor
  "editor.background": string;
  "editor.foreground": string;
  "editor.gutter.background": string;
  "editor.active_line.background": string;
  "editor.active_line_number": string;
  "editor.line_number": string;
  "editor.highlighted_line.background": string;
  "editor.indent_guide": string;
  "editor.indent_guide_active": string;
  "editor.invisible": string;
  "editor.wrap_guide": string;
  "editor.active_wrap_guide": string;
  "editor.document_highlight.read_background": string;
  "editor.document_highlight.write_background": string;
  "editor.document_highlight.bracket_background": string;
  "editor.subheader.background": string;

  // Text
  text: string;
  "text.muted": string;
  "text.placeholder": string;
  "text.disabled": string;
  "text.accent": string;

  // Borders
  border: string;
  "border.variant": string;
  "border.focused": string;
  "border.selected": string;
  "border.transparent": string;
  "border.disabled": string;

  // UI Elements
  "element.background": string;
  "element.hover": string;
  "element.active": string;
  "element.selected": string;
  "element.disabled": string;
  "ghost_element.background": string;
  "ghost_element.hover": string;
  "ghost_element.active": string;
  "ghost_element.selected": string;
  "ghost_element.disabled": string;

  // Icons & Links
  icon: string;
  "icon.muted": string;
  "icon.disabled": string;
  "icon.placeholder": string;
  "icon.accent": string;
  "link_text.hover": string;

  // Status colors
  error: string;
  "error.background": string;
  "error.border": string;
  warning: string;
  "warning.background": string;
  "warning.border": string;
  success: string;
  "success.background": string;
  "success.border": string;
  info: string;
  "info.background": string;
  "info.border": string;
  hint: string;
  "hint.background": string;
  "hint.border": string;
  predictive: string;
  "predictive.background": string;
  "predictive.border": string;
  unreachable: string;
  "unreachable.background": string;
  "unreachable.border": string;

  // Git status
  created: string;
  "created.background": string;
  "created.border": string;
  modified: string;
  "modified.background": string;
  "modified.border": string;
  deleted: string;
  "deleted.background": string;
  "deleted.border": string;
  conflict: string;
  "conflict.background": string;
  "conflict.border": string;
  hidden: string;
  "hidden.background": string;
  "hidden.border": string;
  ignored: string;
  "ignored.background": string;
  "ignored.border": string;
  renamed: string;
  "renamed.background": string;
  "renamed.border": string;

  // Search
  "search.match_background": string;

  // Tabs
  "tab_bar.background": string;
  "tab.active_background": string;
  "tab.inactive_background": string;

  // Toolbar & Title bar
  "toolbar.background": string;
  "title_bar.background": string;
  "title_bar.inactive_background": string;

  // Panel & Status bar
  "panel.background": string;
  "panel.focused_border": string;
  "status_bar.background": string;

  // Scrollbar
  "scrollbar.thumb.background": string;
  "scrollbar.thumb.hover_background": string;
  "scrollbar.thumb.border": string;
  "scrollbar.track.background": string;
  "scrollbar.track.border": string;

  // Terminal
  "terminal.background": string;
  "terminal.foreground": string;
  "terminal.bright_foreground": string;
  "terminal.dim_foreground": string;
  "terminal.ansi.black": string;
  "terminal.ansi.red": string;
  "terminal.ansi.green": string;
  "terminal.ansi.yellow": string;
  "terminal.ansi.blue": string;
  "terminal.ansi.magenta": string;
  "terminal.ansi.cyan": string;
  "terminal.ansi.white": string;
  "terminal.ansi.bright_black": string;
  "terminal.ansi.bright_red": string;
  "terminal.ansi.bright_green": string;
  "terminal.ansi.bright_yellow": string;
  "terminal.ansi.bright_blue": string;
  "terminal.ansi.bright_magenta": string;
  "terminal.ansi.bright_cyan": string;
  "terminal.ansi.bright_white": string;
  "terminal.ansi.dim_black"?: string;
  "terminal.ansi.dim_red"?: string;
  "terminal.ansi.dim_green"?: string;
  "terminal.ansi.dim_yellow"?: string;
  "terminal.ansi.dim_blue"?: string;
  "terminal.ansi.dim_magenta"?: string;
  "terminal.ansi.dim_cyan"?: string;
  "terminal.ansi.dim_white"?: string;

  // Players (multiplayer cursors)
  players: ZedPlayerColor[];

  // Syntax highlighting
  syntax: Record<string, ZedHighlightStyle>;
};

type ZedTheme = {
  name: string;
  appearance: "light" | "dark";
  style: ZedThemeStyle;
};

type ZedThemeFamilyContent = {
  $schema: string;
  name: string;
  author: string;
  themes: ZedTheme[];
};

export type ZedThemeVariant = {
  name: string;
  appearance: "light" | "dark";
  roles: Roles;
};

export function makeZedThemeFamily(
  familyName: string,
  author: string,
  variants: ZedThemeVariant[]
): ZedThemeFamilyContent {
  return {
    $schema: "https://zed.dev/schema/themes/v0.2.0.json",
    name: familyName,
    author,
    themes: variants.map((v) => makeZedTheme(v.name, v.appearance, v.roles)),
  };
}

function makeZedTheme(
  name: string,
  appearance: "light" | "dark",
  c: Roles
): ZedTheme {
  const isDark = appearance === "dark";

  return {
    name,
    appearance,
    style: {
      // Backgrounds
      background: c.bg.window,
      "surface.background": c.bg.window,
      "elevated_surface.background": c.bg.elevated,
      "drop_target.background": alpha(c.accent.primary, 0.15),

      // Editor
      "editor.background": c.bg.editor,
      "editor.foreground": c.fg.base,
      "editor.gutter.background": c.bg.editor,
      "editor.active_line.background": alpha(c.accent.subtle, 0.55),
      "editor.active_line_number": c.fg.fg2,
      "editor.line_number": c.fg.fg3,
      "editor.highlighted_line.background": alpha(c.accent.subtle, 0.35),
      "editor.indent_guide": c.border.indentGuide,
      "editor.indent_guide_active": c.border.indentGuideActive,
      "editor.invisible": c.fg.fg4,
      "editor.wrap_guide": c.border.indentGuide,
      "editor.active_wrap_guide": c.border.indentGuideActive,
      "editor.document_highlight.read_background": alpha(c.accent.primary, isDark ? 0.15 : 0.1),
      "editor.document_highlight.write_background": alpha(c.accent.primary, isDark ? 0.25 : 0.18),
      "editor.document_highlight.bracket_background": alpha(c.accent.primary, 0.2),
      "editor.subheader.background": c.bg.window,

      // Text
      text: c.fg.base,
      "text.muted": c.fg.fg3,
      "text.placeholder": c.fg.fg4,
      "text.disabled": c.fg.fg4,
      "text.accent": c.accent.primary,

      // Borders - use darker borders for dark themes
      border: isDark ? c.border.indentGuide : c.border.editor,
      "border.variant": isDark ? c.border.indentGuideActive : c.border.window,
      "border.focused": c.accent.primary,
      "border.selected": c.accent.primary,
      "border.transparent": "transparent",
      "border.disabled": isDark ? c.border.indentGuideActive : c.border.inset,

      // UI Elements
      "element.background": c.bg.inset,
      "element.hover": alpha(c.accent.subtle, 0.5),
      "element.active": alpha(c.accent.subtle, 0.7),
      "element.selected": alpha(c.accent.subtle, isDark ? 0.6 : 0.8),
      "element.disabled": alpha(c.bg.inset, 0.5),
      "ghost_element.background": "transparent",
      "ghost_element.hover": alpha(c.accent.subtle, 0.35),
      "ghost_element.active": alpha(c.accent.subtle, 0.55),
      "ghost_element.selected": alpha(c.accent.subtle, isDark ? 0.5 : 0.65),
      "ghost_element.disabled": "transparent",

      // Icons & Links
      icon: c.fg.fg2,
      "icon.muted": c.fg.fg3,
      "icon.disabled": c.fg.fg4,
      "icon.placeholder": c.fg.fg4,
      "icon.accent": c.accent.primary,
      "link_text.hover": c.accent.link,

      // Status colors
      error: c.states.danger,
      "error.background": alpha(c.states.danger, 0.1),
      "error.border": alpha(c.states.danger, 0.3),
      warning: c.accent.primary,
      "warning.background": alpha(c.accent.primary, 0.1),
      "warning.border": alpha(c.accent.primary, 0.3),
      success: c.states.success,
      "success.background": alpha(c.states.success, 0.1),
      "success.border": alpha(c.states.success, 0.3),
      info: c.states.info,
      "info.background": alpha(c.states.info, 0.1),
      "info.border": alpha(c.states.info, 0.3),
      hint: c.fg.fg3,
      "hint.background": alpha(c.fg.fg3, 0.1),
      "hint.border": alpha(c.fg.fg3, 0.2),
      predictive: c.fg.fg4,
      "predictive.background": alpha(c.fg.fg4, 0.1),
      "predictive.border": alpha(c.fg.fg4, 0.2),
      unreachable: c.fg.fg4,
      "unreachable.background": alpha(c.fg.fg4, 0.05),
      "unreachable.border": alpha(c.fg.fg4, 0.1),

      // Git status
      created: c.states.success,
      "created.background": alpha(c.states.success, 0.1),
      "created.border": alpha(c.states.success, 0.3),
      modified: c.accent.primary,
      "modified.background": alpha(c.accent.primary, 0.1),
      "modified.border": alpha(c.accent.primary, 0.3),
      deleted: c.states.danger,
      "deleted.background": alpha(c.states.danger, 0.1),
      "deleted.border": alpha(c.states.danger, 0.3),
      conflict: c.accent.primary,
      "conflict.background": alpha(c.accent.primary, 0.1),
      "conflict.border": alpha(c.accent.primary, 0.3),
      hidden: c.fg.fg4,
      "hidden.background": alpha(c.fg.fg4, 0.05),
      "hidden.border": alpha(c.fg.fg4, 0.1),
      ignored: c.fg.fg3,
      "ignored.background": alpha(c.fg.fg3, 0.05),
      "ignored.border": alpha(c.fg.fg3, 0.1),
      renamed: c.states.info,
      "renamed.background": alpha(c.states.info, 0.1),
      "renamed.border": alpha(c.states.info, 0.3),

      // Search
      "search.match_background": alpha(c.states.warn, 0.3),

      // Tabs
      "tab_bar.background": c.bg.window,
      "tab.active_background": c.bg.window,
      "tab.inactive_background": c.bg.window,

      // Toolbar & Title bar
      "toolbar.background": c.bg.window,
      "title_bar.background": c.bg.window,
      "title_bar.inactive_background": c.bg.window,

      // Panel & Status bar
      "panel.background": c.bg.window,
      "panel.focused_border": c.accent.primary,
      "status_bar.background": c.bg.window,

      // Scrollbar
      "scrollbar.thumb.background": alpha(c.fg.fg4, 0.3),
      "scrollbar.thumb.hover_background": alpha(c.fg.fg4, 0.5),
      "scrollbar.thumb.border": "transparent",
      "scrollbar.track.background": "transparent",
      "scrollbar.track.border": "transparent",

      // Terminal
      "terminal.background": c.bg.window,
      "terminal.foreground": c.fg.fg2,
      "terminal.bright_foreground": c.fg.base,
      "terminal.dim_foreground": c.fg.fg3,
      "terminal.ansi.black": c.ansi.black,
      "terminal.ansi.red": c.ansi.red,
      "terminal.ansi.green": c.ansi.green,
      "terminal.ansi.yellow": c.ansi.yellow,
      "terminal.ansi.blue": c.ansi.blue,
      "terminal.ansi.magenta": c.ansi.magenta,
      "terminal.ansi.cyan": c.ansi.cyan,
      "terminal.ansi.white": c.ansi.white,
      "terminal.ansi.bright_black": c.ansi.brightBlack,
      "terminal.ansi.bright_red": c.ansi.brightRed,
      "terminal.ansi.bright_green": c.ansi.brightGreen,
      "terminal.ansi.bright_yellow": c.ansi.brightYellow,
      "terminal.ansi.bright_blue": c.ansi.brightBlue,
      "terminal.ansi.bright_magenta": c.ansi.brightMagenta,
      "terminal.ansi.bright_cyan": c.ansi.brightCyan,
      "terminal.ansi.bright_white": c.ansi.brightWhite,

      // Players (multiplayer cursors) - use colors from the palette
      players: [
        { cursor: c.accent.primary, background: c.accent.primary, selection: alpha(c.accent.primary, 0.25) },
        { cursor: c.states.success, background: c.states.success, selection: alpha(c.states.success, 0.25) },
        { cursor: c.syntax.keyword, background: c.syntax.keyword, selection: alpha(c.syntax.keyword, 0.25) },
        { cursor: c.syntax.func, background: c.syntax.func, selection: alpha(c.syntax.func, 0.25) },
        { cursor: c.syntax.string, background: c.syntax.string, selection: alpha(c.syntax.string, 0.25) },
        { cursor: c.states.warn, background: c.states.warn, selection: alpha(c.states.warn, 0.25) },
        { cursor: c.syntax.type, background: c.syntax.type, selection: alpha(c.syntax.type, 0.25) },
        { cursor: c.states.info, background: c.states.info, selection: alpha(c.states.info, 0.25) },
      ],

      // Syntax highlighting
      syntax: {
        // Comments
        comment: { color: c.syntax.comment },
        "comment.doc": { color: c.syntax.comment },

        // Strings
        string: { color: c.syntax.string },
        "string.escape": { color: c.syntax.escape },
        "string.regex": { color: c.syntax.regexp },
        "string.special": { color: c.syntax.escape },
        "string.special.symbol": { color: c.syntax.constant },

        // Numbers & Constants
        number: { color: c.syntax.number },
        constant: { color: c.syntax.constant },
        boolean: { color: c.syntax.number },

        // Keywords
        keyword: { color: c.syntax.keyword },
        "keyword.operator": { color: c.syntax.operator },

        // Functions
        function: { color: c.syntax.func },
        "function.method": { color: c.syntax.func },
        "function.builtin": { color: c.syntax.func },
        "function.special.definition": { color: c.syntax.func },
        // CSS/SCSS function calls like var(), calc(), light-dark()
        "function.call": { color: c.syntax.func },

        // Types
        type: { color: c.syntax.type },
        "type.builtin": { color: c.syntax.type },
        constructor: { color: c.syntax.type },

        // Variables
        variable: { color: c.syntax.variable },
        "variable.builtin": { color: c.syntax.namespace },  // this, self, super
        "variable.member": { color: c.syntax.variable },
        "variable.parameter": { color: c.syntax.parameter },
        "variable.special": { color: c.syntax.namespace },

        // Properties - Used for JS object keys and property access
        // Keep as variable color (orange) for JS compatibility
        property: { color: c.syntax.variable },

        // ========================================
        // CSS/SCSS SPECIFIC
        // ========================================
        // CSS property names (e.g., position, display, margin) - blue
        // These more specific scopes should override `property` for CSS
        "property.css": { color: c.accent.primary },
        "property.definition": { color: c.accent.primary },
        property_name: { color: c.accent.primary },

        // CSS property values that are keywords (e.g., relative, flex, auto, solid)
        "value": { color: c.syntax.number },
        "constant.css": { color: c.syntax.constant },
        "string.plain": { color: c.syntax.number },
        plain_value: { color: c.syntax.number },

        // CSS selectors - element/tag selectors (p, ul, ol, div, table)
        "tag.css": { color: c.syntax.tag },
        tag_name: { color: c.syntax.tag },
        // Class selectors (.prose, .container)
        "class": { color: c.syntax.attribute },
        class_name: { color: c.syntax.attribute },
        "selector.class": { color: c.syntax.attribute },
        // ID selectors (#main)
        "selector.id": { color: c.syntax.func },
        id_name: { color: c.syntax.func },
        // Pseudo-elements and pseudo-classes (::before, :hover)
        "selector.pseudo": { color: c.syntax.operator },
        pseudo_class_selector: { color: c.syntax.operator },
        pseudo_element_selector: { color: c.syntax.operator },

        // @-rules (@use, @layer, @media, @mixin)
        "keyword.directive": { color: c.syntax.keyword },
        "keyword.control.at-rule": { color: c.syntax.keyword },
        at_keyword: { color: c.syntax.keyword },

        // SCSS/CSS variables - these should be orange (variable color)
        // SCSS variables ($variable)
        "variable.scss": { color: c.syntax.variable },
        // CSS custom properties (--custom-prop) - orange
        "variable.css": { color: c.syntax.variable },
        "property.custom": { color: c.syntax.variable },

        // Units (px, em, %, rem)
        "unit": { color: c.syntax.number },
        "number.unit": { color: c.syntax.number },

        // Colors
        "color": { color: c.syntax.constant },
        "constant.color": { color: c.syntax.constant },

        // Important
        "keyword.important": { color: c.syntax.keyword },

        // ========================================
        // END CSS/SCSS SPECIFIC
        // ========================================

        // ========================================
        // JAVASCRIPT/TYPESCRIPT SPECIFIC
        // ========================================
        // `this`, `self`, `super` - namespace/yellow color
        "variable.language": { color: c.syntax.namespace },
        this: { color: c.syntax.namespace },
        self: { color: c.syntax.namespace },

        // Class/Type names (Dropdown, BaseComponent, TypeError)
        "type.class": { color: c.syntax.type },
        // Note: class_name is defined in CSS section for CSS class selectors

        // Object literal keys
        "property.object": { color: c.syntax.variable },
        property_identifier: { color: c.syntax.variable },
        shorthand_property_identifier: { color: c.syntax.variable },
        shorthand_property_identifier_pattern: { color: c.syntax.variable },

        // Method definitions and calls
        method_definition: { color: c.syntax.func },
        "function.method.call": { color: c.syntax.func },

        // Template literal interpolation
        "string.template": { color: c.syntax.string },
        template_string: { color: c.syntax.string },

        // JSX
        "tag.jsx": { color: c.syntax.tag },
        "tag.component": { color: c.syntax.type },

        // ========================================
        // END JAVASCRIPT/TYPESCRIPT SPECIFIC
        // ========================================

        // Punctuation
        punctuation: { color: c.syntax.punctuation },
        "punctuation.bracket": { color: c.syntax.punctuation },
        "punctuation.delimiter": { color: c.syntax.punctuation },
        "punctuation.list_marker": { color: c.syntax.punctuation },
        "punctuation.special": { color: c.syntax.keyword },

        // Operators
        operator: { color: c.syntax.operator },

        // Tags (HTML/XML/JSX)
        tag: { color: c.syntax.tag },
        attribute: { color: c.syntax.attribute },

        // Labels & Namespaces
        label: { color: c.syntax.namespace },
        namespace: { color: c.syntax.namespace },

        // Embedded / Preprocessor
        embedded: { color: c.fg.base },
        preproc: { color: c.syntax.keyword },

        // Markup
        "text.literal": { color: c.syntax.string },
        "markup.heading": { color: c.syntax.tag, font_weight: 700 },
        "markup.bold": { color: c.syntax.constant, font_weight: 700 },
        "markup.italic": { color: c.syntax.keyword, font_style: "italic" },
        "markup.strikethrough": { color: c.fg.fg3 },
        "markup.link.url": { color: c.accent.link },
        "markup.link.text": { color: c.syntax.func },
        "markup.quote": { color: c.syntax.comment, font_style: "italic" },
        "markup.list": { color: c.syntax.tag },
        "markup.list.numbered": { color: c.syntax.tag },
        "markup.list.unnumbered": { color: c.syntax.tag },
        "markup.raw": { color: c.syntax.string },
        "markup.raw.inline": { color: c.syntax.string },
        "markup.raw.block": { color: c.syntax.string },

        // Diff
        "diff.plus": { color: c.states.success },
        "diff.minus": { color: c.states.danger },
        "diff.delta": { color: c.states.warn },

        // Links
        link_text: { color: c.accent.link },
        link_uri: { color: c.syntax.keyword },

        // Emphasis & Primary
        emphasis: { font_style: "italic" },
        "emphasis.strong": { font_weight: 700 },
        primary: { color: c.accent.primary },
        title: { color: c.syntax.tag, font_weight: 700 },

        // Predictive / AI suggestions
        predictive: { color: c.fg.fg4, font_style: "italic" },
      },
    },
  };
}

// Helper: add alpha to hex color
function alpha(color: string, opacity: number): string {
  // Handle Display P3 color format
  if (color.startsWith("color(display-p3")) {
    if (color.includes(" / ")) {
      return color.replace(/ \/ [\d.]+\)$/, ` / ${opacity.toFixed(6)})`);
    } else {
      return color.replace(/\)$/, ` / ${opacity.toFixed(6)})`);
    }
  }

  // Handle hex color format
  const alphaHex = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${alphaHex}`;
}
