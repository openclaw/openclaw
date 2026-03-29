// src/theme.ts
import type { Roles } from "./palette";

type VSCodeTheme = {
  name: string;
  type: "light" | "dark";
  colors: Record<string, string>;
  tokenColors: any[];
  semanticTokenColors: Record<string,string|{foreground:string;fontStyle?:string}>;
};

export function makeTheme(name: string, kind: "light"|"dark", c: Roles): VSCodeTheme {
  return {
    name,
    type: kind,
    colors: {
      // Core editor & text
      "editor.background": c.bg.editor,
      "editor.foreground": c.fg.base,
      "foreground": c.fg.base,
      "focusBorder": c.accent.primary,
      "selection.background": c.accent.subtle,

      // Editor chrome
      "editor.selectionBackground": alpha(c.accent.primary, kind === "dark" ? 0.30 : 0.18),
      "editor.lineHighlightBackground": alpha(c.accent.subtle, 0.55),
      "editorCursor.foreground": c.accent.primary,
      "editorLineNumber.foreground": c.fg.fg3,
      "editorLineNumber.activeForeground": c.fg.fg2,
      "editorIndentGuide.background": c.border.indentGuide,
      "editorIndentGuide.activeBackground": c.border.indentGuideActive,

      "diffEditor.insertedTextBackground": alpha(c.states.success, kind === "dark" ? 0.1 : 0.2),
      "diffEditor.deletedTextBackground": alpha(c.states.danger, kind === "dark" ? 0.1 : 0.2),

      // Sidebar
      "sideBar.background": c.bg.window,
      "sideBar.foreground": c.fg.fg2,
      "sideBar.border": c.border.window,
      "sideBarTitle.foreground": c.fg.base,
      "sideBarSectionHeader.background": c.bg.window,
      "sideBarSectionHeader.foreground": c.fg.fg2,
      "sideBarSectionHeader.border": c.border.window,

      // Activity bar
      "activityBar.background": c.bg.window,
      "activityBar.foreground": c.fg.base,
      "activityBar.border": c.border.window,
      "activityBar.activeBorder": c.accent.primary,
      "activityBarBadge.background": c.accent.primary,
      "activityBarBadge.foreground": c.accent.contrastOnAccent,

      // Title bar
      "titleBar.activeBackground": c.bg.window,
      "titleBar.activeForeground": c.fg.base,
      "titleBar.inactiveBackground": c.bg.window,
      "titleBar.inactiveForeground": c.fg.fg3,
      "titleBar.border": c.border.window,

      // Lists
      "list.activeSelectionBackground": alpha(c.accent.subtle, kind === "dark" ? 0.6 : 0.8),
      "list.activeSelectionForeground": c.fg.base,
      "list.inactiveSelectionBackground": alpha(c.accent.subtle, 0.45),
      "list.hoverBackground": alpha(c.accent.subtle, 0.35),
      "list.focusOutline": c.accent.primary,

      // Tabs
      "tab.activeBackground": c.bg.editor,
      "tab.activeForeground": c.fg.base,
      "tab.activeBorderTop": c.accent.primary,
      "tab.inactiveBackground": c.bg.window,
      "tab.inactiveForeground": c.fg.fg3,
      "tab.border": c.border.window,
      "editorGroupHeader.tabsBackground": c.bg.window,
      "editorGroupHeader.tabsBorder": c.border.window,

      // Panel
      "panel.background": c.bg.window,
      "panel.border": c.border.window,
      "panelTitle.activeBorder": c.accent.primary,
      "panelTitle.activeForeground": c.fg.base,
      "panelTitle.inactiveForeground": c.fg.fg3,

      // Status bar
      "statusBar.background": c.bg.window,
      "statusBar.foreground": c.fg.fg2,
      "statusBar.border": c.border.window,
      "statusBar.noFolderBackground": c.bg.window,
      "statusBar.debuggingBackground": c.states.warn,
      "statusBar.debuggingForeground": c.accent.contrastOnAccent,
      "statusBarItem.remoteBackground": c.bg.window,
      "statusBarItem.remoteForeground": c.fg.fg2,

      // Inputs & dropdowns
      "input.background": c.bg.inset,
      "input.border": c.border.inset,
      "input.foreground": c.fg.base,
      "input.placeholderForeground": c.fg.fg4,
      "dropdown.background": c.bg.inset,
      "dropdown.border": c.border.inset,
      "dropdown.foreground": c.fg.base,

      // Buttons
      "button.background": c.accent.primary,
      "button.foreground": c.accent.contrastOnAccent,
      "button.hoverBackground": mix(c.accent.primary, c.accent.contrastOnAccent, 0.1),

      // Links
      "textLink.foreground": c.accent.link,
      "textLink.activeForeground": c.accent.primary,

      // Git colors
      "gitDecoration.addedResourceForeground": c.states.success,
      "gitDecoration.conflictingResourceForeground": c.states.warn,
      "gitDecoration.modifiedResourceForeground": c.accent.primary,
      "gitDecoration.deletedResourceForeground": c.states.danger,
      "gitDecoration.untrackedResourceForeground": c.states.success,
      "gitDecoration.ignoredResourceForeground": c.fg.fg3,

      // Terminal ANSI colors
      "terminal.titleForeground": c.fg.fg2,
      "terminal.titleInactiveForeground": c.fg.fg3,
      "terminal.background": c.bg.window,
      "terminal.foreground": c.fg.fg2,
      "terminal.ansiBlack": c.ansi.black,
      "terminal.ansiRed": c.ansi.red,
      "terminal.ansiGreen": c.ansi.green,
      "terminal.ansiYellow": c.ansi.yellow,
      "terminal.ansiBlue": c.ansi.blue,
      "terminal.ansiMagenta": c.ansi.magenta,
      "terminal.ansiCyan": c.ansi.cyan,
      "terminal.ansiWhite": c.ansi.white,
      "terminal.ansiBrightBlack": c.ansi.brightBlack,
      "terminal.ansiBrightRed": c.ansi.brightRed,
      "terminal.ansiBrightGreen": c.ansi.brightGreen,
      "terminal.ansiBrightYellow": c.ansi.brightYellow,
      "terminal.ansiBrightBlue": c.ansi.brightBlue,
      "terminal.ansiBrightMagenta": c.ansi.brightMagenta,
      "terminal.ansiBrightCyan": c.ansi.brightCyan,
      "terminal.ansiBrightWhite": c.ansi.brightWhite
    },

    tokenColors: [
      // ========================================
      // COMMENTS
      // ========================================
      { scope: ["comment","punctuation.definition.comment"], settings: { foreground: c.syntax.comment } },
      { scope: "comment markup.link", settings: { foreground: c.syntax.comment } },

      // ========================================
      // STRINGS
      // ========================================
      { scope: ["string","constant.other.symbol"], settings: { foreground: c.syntax.string } },
      { scope: ["punctuation.definition.string.begin","punctuation.definition.string.end"], settings: { foreground: c.syntax.string } },

      // ========================================
      // NUMBERS & CONSTANTS
      // ========================================
      { scope: ["constant.numeric","constant.language.boolean"], settings: { foreground: c.syntax.number } },
      { scope: "constant", settings: { foreground: c.syntax.constant } },
      { scope: "punctuation.definition.constant", settings: { foreground: c.syntax.constant } },
      { scope: "constant.language", settings: { foreground: c.syntax.number } },
      { scope: "variable.other.constant", settings: { foreground: c.syntax.namespace } },

      // ========================================
      // KEYWORDS & STORAGE
      // ========================================
      { scope: "keyword", settings: { foreground: c.syntax.keyword } },
      { scope: "keyword.control", settings: { foreground: c.syntax.keyword } },
      { scope: ["storage","storage.type","storage.modifier"], settings: { foreground: c.syntax.keyword } },
      { scope: "token.storage", settings: { foreground: c.syntax.keyword } },
      { scope: ["keyword.operator.new","keyword.operator.expression.instanceof","keyword.operator.expression.typeof","keyword.operator.expression.void","keyword.operator.expression.delete","keyword.operator.expression.in","keyword.operator.expression.of","keyword.operator.expression.keyof"], settings: { foreground: c.syntax.keyword } },
      { scope: "keyword.operator.delete", settings: { foreground: c.syntax.keyword } },

      // ========================================
      // VARIABLES & IDENTIFIERS
      // ========================================
      { scope: ["variable","identifier","meta.definition.variable"], settings: { foreground: c.syntax.variable } },
      { scope: ["variable.other.readwrite","meta.object-literal.key","support.variable.property","support.variable.object.process","support.variable.object.node"], settings: { foreground: c.syntax.variable } },
      { scope: "variable.language", settings: { foreground: c.syntax.namespace } },
      { scope: "variable.parameter.function", settings: { foreground: c.syntax.parameter } },
      { scope: "function.parameter", settings: { foreground: c.syntax.parameter } },
      { scope: "variable.parameter", settings: { foreground: c.syntax.parameter } },
      { scope: "variable.parameter.function.language.python", settings: { foreground: c.syntax.constant } },
      { scope: "variable.parameter.function.python", settings: { foreground: c.syntax.constant } },

      // ========================================
      // FUNCTIONS & METHODS
      // ========================================
      { scope: ["support.function","entity.name.function","meta.function-call","meta.require","support.function.any-method","variable.function"], settings: { foreground: c.syntax.func } },
      { scope: "keyword.other.special-method", settings: { foreground: c.syntax.func } },
      { scope: "entity.name.function", settings: { foreground: c.syntax.func } },
      { scope: "support.function.console", settings: { foreground: c.syntax.func } },

      // ========================================
      // TYPES & CLASSES
      // ========================================
      { scope: ["support.type","entity.name.type","entity.name.class","storage.type"], settings: { foreground: c.syntax.type } },
      { scope: ["support.class","entity.name.type.class"], settings: { foreground: c.syntax.type } },
      { scope: ["entity.name.class","variable.other.class.js","variable.other.class.ts"], settings: { foreground: c.syntax.type } },
      { scope: "entity.name.class.identifier.namespace.type", settings: { foreground: c.syntax.type } },
      { scope: "entity.name.type.namespace", settings: { foreground: c.syntax.namespace } },
      { scope: "entity.other.inherited-class", settings: { foreground: c.syntax.type } },
      { scope: "entity.name.namespace", settings: { foreground: c.syntax.namespace } },

      // ========================================
      // OPERATORS
      // ========================================
      { scope: "keyword.operator", settings: { foreground: c.syntax.punctuation } },
      { scope: ["keyword.operator.logical","keyword.operator.bitwise","keyword.operator.channel"], settings: { foreground: c.syntax.operator } },
      { scope: ["keyword.operator.arithmetic","keyword.operator.comparison","keyword.operator.relational","keyword.operator.increment","keyword.operator.decrement"], settings: { foreground: c.syntax.operator } },
      { scope: "keyword.operator.assignment", settings: { foreground: c.syntax.operator } },
      { scope: "keyword.operator.assignment.compound", settings: { foreground: c.syntax.keyword } },
      { scope: ["keyword.operator.assignment.compound.js","keyword.operator.assignment.compound.ts"], settings: { foreground: c.syntax.operator } },
      { scope: "keyword.operator.ternary", settings: { foreground: c.syntax.keyword } },
      { scope: "keyword.operator.optional", settings: { foreground: c.syntax.keyword } },

      // ========================================
      // PUNCTUATION
      // ========================================
      { scope: "punctuation", settings: { foreground: c.syntax.punctuation } },
      { scope: "punctuation.separator.delimiter", settings: { foreground: c.syntax.punctuation } },
      { scope: "punctuation.separator.key-value", settings: { foreground: c.syntax.punctuation } },
      { scope: "punctuation.terminator", settings: { foreground: c.syntax.punctuation } },
      { scope: "meta.brace", settings: { foreground: c.syntax.punctuation } },
      { scope: "meta.brace.square", settings: { foreground: c.syntax.punctuation } },
      { scope: "meta.brace.round", settings: { foreground: c.syntax.punctuation } },
      { scope: "function.brace", settings: { foreground: c.syntax.punctuation } },
      { scope: ["punctuation.definition.parameters","punctuation.definition.typeparameters"], settings: { foreground: c.syntax.punctuation } },
      { scope: ["punctuation.definition.block","punctuation.definition.tag"], settings: { foreground: c.syntax.punctuation } },
      { scope: ["meta.tag.tsx","meta.tag.jsx","meta.tag.js","meta.tag.ts"], settings: { foreground: c.syntax.punctuation } },

      // ========================================
      // JAVASCRIPT/TYPESCRIPT SPECIFIC
      // ========================================
      { scope: "keyword.operator.expression.import", settings: { foreground: c.syntax.func } },
      { scope: "keyword.operator.module", settings: { foreground: c.syntax.keyword } },
      { scope: "support.type.object.console", settings: { foreground: c.syntax.variable } },
      { scope: ["support.module.node","support.type.object.module","entity.name.type.module"], settings: { foreground: c.syntax.namespace } },
      { scope: "support.constant.math", settings: { foreground: c.syntax.namespace } },
      { scope: "support.constant.property.math", settings: { foreground: c.syntax.constant } },
      { scope: "support.constant.json", settings: { foreground: c.syntax.constant } },
      { scope: "support.type.object.dom", settings: { foreground: c.syntax.operator } },
      { scope: ["support.variable.dom","support.variable.property.dom"], settings: { foreground: c.syntax.variable } },
      { scope: "support.variable.property.process", settings: { foreground: c.syntax.constant } },
      { scope: "meta.property.object", settings: { foreground: c.syntax.variable } },
      { scope: "variable.parameter.function.js", settings: { foreground: c.syntax.variable } },

      // Template literals
      { scope: ["keyword.other.template.begin","keyword.other.template.end"], settings: { foreground: c.syntax.string } },
      { scope: ["keyword.other.substitution.begin","keyword.other.substitution.end"], settings: { foreground: c.syntax.string } },
      { scope: ["punctuation.definition.template-expression.begin","punctuation.definition.template-expression.end"], settings: { foreground: c.syntax.keyword } },
      { scope: "meta.template.expression", settings: { foreground: c.syntax.punctuation } },
      { scope: "punctuation.section.embedded", settings: { foreground: c.syntax.variable } },
      { scope: "variable.interpolation", settings: { foreground: c.syntax.variable } },
      { scope: ["punctuation.section.embedded.begin","punctuation.section.embedded.end"], settings: { foreground: c.syntax.keyword } },
      { scope: "punctuation.quasi.element", settings: { foreground: c.syntax.keyword } },

      // TypeScript/Flow
      { scope: ["support.type.primitive.ts","support.type.builtin.ts","support.type.primitive.tsx","support.type.builtin.tsx"], settings: { foreground: c.syntax.type } },
      { scope: "support.type.type.flowtype", settings: { foreground: c.syntax.func } },
      { scope: "support.type.primitive", settings: { foreground: c.syntax.type } },

      // ========================================
      // PYTHON SPECIFIC
      // ========================================
      { scope: "support.variable.magic.python", settings: { foreground: c.syntax.tag } },
      { scope: "variable.parameter.function.language.special.self.python", settings: { foreground: c.syntax.namespace } },
      { scope: ["punctuation.separator.period.python","punctuation.separator.element.python","punctuation.parenthesis.begin.python","punctuation.parenthesis.end.python"], settings: { foreground: c.syntax.punctuation } },
      { scope: ["punctuation.definition.arguments.begin.python","punctuation.definition.arguments.end.python","punctuation.separator.arguments.python","punctuation.definition.list.begin.python","punctuation.definition.list.end.python"], settings: { foreground: c.syntax.punctuation } },
      { scope: "support.type.python", settings: { foreground: c.syntax.operator } },
      { scope: "keyword.operator.logical.python", settings: { foreground: c.syntax.keyword } },
      { scope: "meta.function-call.generic.python", settings: { foreground: c.syntax.func } },
      { scope: "constant.character.format.placeholder.other.python", settings: { foreground: c.syntax.constant } },
      { scope: "meta.function.decorator.python", settings: { foreground: c.syntax.func } },
      { scope: ["support.token.decorator.python","meta.function.decorator.identifier.python"], settings: { foreground: c.syntax.operator } },

      // ========================================
      // RUST SPECIFIC
      // ========================================
      { scope: "storage.modifier.lifetime.rust", settings: { foreground: c.syntax.punctuation } },
      { scope: "support.function.std.rust", settings: { foreground: c.syntax.func } },
      { scope: "entity.name.lifetime.rust", settings: { foreground: c.syntax.namespace } },
      { scope: "variable.language.rust", settings: { foreground: c.syntax.tag } },
      { scope: "keyword.operator.misc.rust", settings: { foreground: c.syntax.punctuation } },
      { scope: "keyword.operator.sigil.rust", settings: { foreground: c.syntax.keyword } },
      { scope: "support.constant.core.rust", settings: { foreground: c.syntax.constant } },

      // ========================================
      // C/C++ SPECIFIC
      // ========================================
      { scope: ["meta.function.c","meta.function.cpp"], settings: { foreground: c.syntax.tag } },
      { scope: ["punctuation.section.block.begin.bracket.curly.cpp","punctuation.section.block.end.bracket.curly.cpp","punctuation.terminator.statement.c","punctuation.section.block.begin.bracket.curly.c","punctuation.section.block.end.bracket.curly.c","punctuation.section.parens.begin.bracket.round.c","punctuation.section.parens.end.bracket.round.c","punctuation.section.parameters.begin.bracket.round.c","punctuation.section.parameters.end.bracket.round.c"], settings: { foreground: c.syntax.punctuation } },
      { scope: ["keyword.operator.assignment.c","keyword.operator.comparison.c","keyword.operator.c","keyword.operator.increment.c","keyword.operator.decrement.c","keyword.operator.bitwise.shift.c"], settings: { foreground: c.syntax.keyword } },
      { scope: ["keyword.operator.assignment.cpp","keyword.operator.comparison.cpp","keyword.operator.cpp","keyword.operator.increment.cpp","keyword.operator.decrement.cpp","keyword.operator.bitwise.shift.cpp"], settings: { foreground: c.syntax.keyword } },
      { scope: ["punctuation.separator.c","punctuation.separator.cpp"], settings: { foreground: c.syntax.keyword } },
      { scope: ["support.type.posix-reserved.c","support.type.posix-reserved.cpp"], settings: { foreground: c.syntax.operator } },
      { scope: ["keyword.operator.sizeof.c","keyword.operator.sizeof.cpp"], settings: { foreground: c.syntax.keyword } },
      { scope: "variable.c", settings: { foreground: c.syntax.punctuation } },

      // ========================================
      // JAVA SPECIFIC
      // ========================================
      { scope: ["storage.type.annotation.java","storage.type.object.array.java"], settings: { foreground: c.syntax.namespace } },
      { scope: "source.java", settings: { foreground: c.syntax.tag } },
      { scope: ["punctuation.section.block.begin.java","punctuation.section.block.end.java","punctuation.definition.method-parameters.begin.java","punctuation.definition.method-parameters.end.java","meta.method.identifier.java","punctuation.section.method.begin.java","punctuation.section.method.end.java","punctuation.terminator.java","punctuation.section.class.begin.java","punctuation.section.class.end.java","punctuation.section.inner-class.begin.java","punctuation.section.inner-class.end.java","meta.method-call.java","punctuation.section.class.begin.bracket.curly.java","punctuation.section.class.end.bracket.curly.java","punctuation.section.method.begin.bracket.curly.java","punctuation.section.method.end.bracket.curly.java","punctuation.separator.period.java","punctuation.bracket.angle.java","punctuation.definition.annotation.java","meta.method.body.java"], settings: { foreground: c.syntax.punctuation } },
      { scope: "meta.method.java", settings: { foreground: c.syntax.func } },
      { scope: ["storage.modifier.import.java","storage.type.java","storage.type.generic.java"], settings: { foreground: c.syntax.namespace } },
      { scope: "keyword.operator.instanceof.java", settings: { foreground: c.syntax.keyword } },
      { scope: "meta.definition.variable.name.java", settings: { foreground: c.syntax.tag } },
      { scope: "token.variable.parameter.java", settings: { foreground: c.syntax.punctuation } },
      { scope: "import.storage.java", settings: { foreground: c.syntax.namespace } },
      { scope: "token.package.keyword", settings: { foreground: c.syntax.keyword } },
      { scope: "token.package", settings: { foreground: c.syntax.punctuation } },
      { scope: "token.storage.type.java", settings: { foreground: c.syntax.namespace } },

      // ========================================
      // GO SPECIFIC
      // ========================================
      { scope: "keyword.operator.assignment.go", settings: { foreground: c.syntax.namespace } },
      { scope: ["keyword.operator.arithmetic.go","keyword.operator.address.go"], settings: { foreground: c.syntax.keyword } },
      { scope: "entity.name.package.go", settings: { foreground: c.syntax.namespace } },

      // ========================================
      // PHP SPECIFIC
      // ========================================
      { scope: ["support.other.namespace.use.php","support.other.namespace.use-as.php","support.other.namespace.php","entity.other.alias.php","meta.interface.php"], settings: { foreground: c.syntax.namespace } },
      { scope: "keyword.operator.error-control.php", settings: { foreground: c.syntax.keyword } },
      { scope: "keyword.operator.type.php", settings: { foreground: c.syntax.keyword } },
      { scope: ["punctuation.section.array.begin.php","punctuation.section.array.end.php"], settings: { foreground: c.syntax.punctuation } },
      { scope: ["storage.type.php","meta.other.type.phpdoc.php","keyword.other.type.php","keyword.other.array.phpdoc.php"], settings: { foreground: c.syntax.namespace } },
      { scope: ["meta.function-call.php","meta.function-call.object.php","meta.function-call.static.php"], settings: { foreground: c.syntax.func } },
      { scope: ["punctuation.definition.parameters.begin.bracket.round.php","punctuation.definition.parameters.end.bracket.round.php","punctuation.separator.delimiter.php","punctuation.section.scope.begin.php","punctuation.section.scope.end.php","punctuation.terminator.expression.php","punctuation.definition.arguments.begin.bracket.round.php","punctuation.definition.arguments.end.bracket.round.php","punctuation.definition.storage-type.begin.bracket.round.php","punctuation.definition.storage-type.end.bracket.round.php","punctuation.definition.array.begin.bracket.round.php","punctuation.definition.array.end.bracket.round.php","punctuation.definition.begin.bracket.round.php","punctuation.definition.end.bracket.round.php","punctuation.definition.begin.bracket.curly.php","punctuation.definition.end.bracket.curly.php","punctuation.definition.section.switch-block.end.bracket.curly.php","punctuation.definition.section.switch-block.start.bracket.curly.php","punctuation.definition.section.switch-block.begin.bracket.curly.php","punctuation.definition.section.switch-block.end.bracket.curly.php"], settings: { foreground: c.syntax.punctuation } },
      { scope: ["support.constant.ext.php","support.constant.std.php","support.constant.core.php","support.constant.parser-token.php"], settings: { foreground: c.syntax.constant } },
      { scope: ["entity.name.goto-label.php","support.other.php"], settings: { foreground: c.syntax.func } },
      { scope: ["keyword.operator.logical.php","keyword.operator.bitwise.php","keyword.operator.arithmetic.php"], settings: { foreground: c.syntax.operator } },
      { scope: "keyword.operator.regexp.php", settings: { foreground: c.syntax.keyword } },
      { scope: "keyword.operator.comparison.php", settings: { foreground: c.syntax.operator } },
      { scope: ["keyword.operator.heredoc.php","keyword.operator.nowdoc.php"], settings: { foreground: c.syntax.keyword } },
      { scope: "variable.other.class.php", settings: { foreground: c.syntax.tag } },
      { scope: "invalid.illegal.non-null-typehinted.php", settings: { foreground: "#f44747" } },

      // ========================================
      // HASKELL SPECIFIC
      // ========================================
      { scope: "variable.other.generic-type.haskell", settings: { foreground: c.syntax.keyword } },
      { scope: "storage.type.haskell", settings: { foreground: c.syntax.constant } },

      // ========================================
      // C# SPECIFIC
      // ========================================
      { scope: "storage.type.cs", settings: { foreground: c.syntax.namespace } },
      { scope: "entity.name.variable.local.cs", settings: { foreground: c.syntax.tag } },
      { scope: "entity.name.label.cs", settings: { foreground: c.syntax.namespace } },
      { scope: ["entity.name.scope-resolution.function.call","entity.name.scope-resolution.function.definition"], settings: { foreground: c.syntax.namespace } },

      // ========================================
      // OTHER LANGUAGES
      // ========================================
      // Unison
      { scope: ["punctuation.definition.delayed.unison","punctuation.definition.list.begin.unison","punctuation.definition.list.end.unison","punctuation.definition.ability.begin.unison","punctuation.definition.ability.end.unison","punctuation.operator.assignment.as.unison","punctuation.separator.pipe.unison","punctuation.separator.delimiter.unison","punctuation.definition.hash.unison"], settings: { foreground: c.syntax.tag } },

      // Edge
      { scope: "support.constant.edge", settings: { foreground: c.syntax.keyword } },

      // Elm
      { scope: "support.type.prelude.elm", settings: { foreground: c.syntax.operator } },
      { scope: "support.constant.elm", settings: { foreground: c.syntax.constant } },

      // Clojure
      { scope: "entity.global.clojure", settings: { foreground: c.syntax.namespace } },
      { scope: "meta.symbol.clojure", settings: { foreground: c.syntax.tag } },
      { scope: "constant.keyword.clojure", settings: { foreground: c.syntax.operator } },

      // CoffeeScript
      { scope: ["meta.arguments.coffee","variable.parameter.function.coffee"], settings: { foreground: c.syntax.tag } },

      // Groovy
      { scope: "storage.modifier.import.groovy", settings: { foreground: c.syntax.namespace } },
      { scope: "meta.method.groovy", settings: { foreground: c.syntax.func } },
      { scope: "meta.definition.variable.name.groovy", settings: { foreground: c.syntax.tag } },
      { scope: "meta.definition.class.inherited.classes.groovy", settings: { foreground: c.syntax.string } },

      // HLSL
      { scope: "support.variable.semantic.hlsl", settings: { foreground: c.syntax.namespace } },
      { scope: ["support.type.texture.hlsl","support.type.sampler.hlsl","support.type.object.hlsl","support.type.object.rw.hlsl","support.type.fx.hlsl","support.type.object.hlsl"], settings: { foreground: c.syntax.keyword } },

      // SQL
      { scope: ["text.variable","text.bracketed"], settings: { foreground: c.syntax.tag } },

      // Swift/VB
      { scope: ["support.type.swift","support.type.vb.asp"], settings: { foreground: c.syntax.namespace } },

      // Makefile
      { scope: "meta.scope.prerequisites.makefile", settings: { foreground: c.syntax.tag } },
      { scope: "source.makefile", settings: { foreground: c.syntax.namespace } },

      // Ini
      { scope: "source.ini", settings: { foreground: c.syntax.string } },

      // Ruby
      { scope: "constant.language.symbol.ruby", settings: { foreground: c.syntax.operator } },
      { scope: ["function.parameter.ruby","function.parameter.cs"], settings: { foreground: c.syntax.punctuation } },

      // Elixir
      { scope: "constant.language.symbol.elixir", settings: { foreground: c.syntax.operator } },

      // Laravel Blade
      { scope: "text.html.laravel-blade source.php.embedded.line.html entity.name.tag.laravel-blade", settings: { foreground: c.syntax.keyword } },
      { scope: "text.html.laravel-blade source.php.embedded.line.html support.constant.laravel-blade", settings: { foreground: c.syntax.keyword } },

      // Xi
      { scope: "entity.name.function.xi", settings: { foreground: c.syntax.namespace } },
      { scope: "entity.name.class.xi", settings: { foreground: c.syntax.operator } },
      { scope: "constant.character.character-class.regexp.xi", settings: { foreground: c.syntax.tag } },
      { scope: "constant.regexp.xi", settings: { foreground: c.syntax.keyword } },
      { scope: "keyword.control.xi", settings: { foreground: c.syntax.operator } },
      { scope: "invalid.xi", settings: { foreground: c.syntax.punctuation } },
      { scope: "beginning.punctuation.definition.quote.markdown.xi", settings: { foreground: c.syntax.string } },
      { scope: "beginning.punctuation.definition.list.markdown.xi", settings: { foreground: c.syntax.comment } },
      { scope: "constant.character.xi", settings: { foreground: c.syntax.func } },
      { scope: "accent.xi", settings: { foreground: c.syntax.func } },
      { scope: "wikiword.xi", settings: { foreground: c.syntax.constant } },
      { scope: "constant.other.color.rgb-value.xi", settings: { foreground: c.syntax.invalid } },
      { scope: "punctuation.definition.tag.xi", settings: { foreground: c.syntax.comment } },

      // ========================================
      // CSS/SCSS/LESS
      // ========================================
      { scope: ["support.constant.property-value.scss","support.constant.property-value.css"], settings: { foreground: c.syntax.constant } },
      { scope: ["keyword.operator.css","keyword.operator.scss","keyword.operator.less"], settings: { foreground: c.syntax.operator } },
      { scope: ["support.constant.color.w3c-standard-color-name.css","support.constant.color.w3c-standard-color-name.scss"], settings: { foreground: c.syntax.constant } },
      { scope: "punctuation.separator.list.comma.css", settings: { foreground: c.syntax.punctuation } },
      { scope: "support.type.vendored.property-name.css", settings: { foreground: c.syntax.operator } },
      { scope: "support.type.property-name.css", settings: { foreground: c.syntax.operator } },
      { scope: "support.type.property-name", settings: { foreground: c.syntax.punctuation } },
      { scope: "support.constant.property-value", settings: { foreground: c.syntax.punctuation } },
      { scope: "support.constant.font-name", settings: { foreground: c.syntax.constant } },
      { scope: "entity.other.attribute-name.class.css", settings: { foreground: c.syntax.attribute, fontStyle: "normal" } },
      { scope: "entity.other.attribute-name.id", settings: { foreground: c.syntax.func, fontStyle: "normal" } },
      { scope: ["entity.other.attribute-name.pseudo-element","entity.other.attribute-name.pseudo-class"], settings: { foreground: c.syntax.operator } },
      { scope: "meta.selector", settings: { foreground: c.syntax.keyword } },
      { scope: "selector.sass", settings: { foreground: c.syntax.tag } },
      { scope: "rgb-value", settings: { foreground: c.syntax.operator } },
      { scope: "inline-color-decoration rgb-value", settings: { foreground: c.syntax.constant } },
      { scope: "less rgb-value", settings: { foreground: c.syntax.constant } },
      { scope: "control.elements", settings: { foreground: c.syntax.constant } },
      { scope: "keyword.operator.less", settings: { foreground: c.syntax.constant } },

      // ========================================
      // HTML/XML
      // ========================================
      { scope: "entity.name.tag", settings: { foreground: c.syntax.tag } },
      { scope: "entity.other.attribute-name", settings: { foreground: c.syntax.attribute, fontStyle: "normal" } },
      { scope: "constant.character.entity", settings: { foreground: c.syntax.tag } },
      { scope: "meta.tag", settings: { foreground: c.syntax.punctuation } },
      { scope: "invalid.illegal.bad-ampersand.html", settings: { foreground: c.syntax.punctuation } },

      // ========================================
      // MARKDOWN
      // ========================================
      { scope: "markup.heading", settings: { foreground: c.syntax.tag } },
      { scope: ["markup.heading punctuation.definition.heading","entity.name.section"], settings: { foreground: c.syntax.func } },
      { scope: "entity.name.section.markdown", settings: { foreground: c.syntax.tag } },
      { scope: "punctuation.definition.heading.markdown", settings: { foreground: c.syntax.tag } },
      { scope: "markup.heading.setext", settings: { foreground: c.syntax.punctuation } },
      { scope: ["markup.heading.setext.1.markdown","markup.heading.setext.2.markdown"], settings: { foreground: c.syntax.tag } },

      { scope: ["markup.bold","todo.bold"], settings: { foreground: c.syntax.constant } },
      { scope: "punctuation.definition.bold", settings: { foreground: c.syntax.namespace } },
      { scope: "punctuation.definition.bold.markdown", settings: { foreground: c.syntax.constant } },

      { scope: ["markup.italic","punctuation.definition.italic","todo.emphasis"], settings: { foreground: c.syntax.keyword, fontStyle: "italic" } },
      { scope: "emphasis md", settings: { foreground: c.syntax.keyword } },
      { scope: "markup.italic.markdown", settings: { fontStyle: "italic" } },

      { scope: ["markup.underline.link.markdown","markup.underline.link.image.markdown"], settings: { foreground: c.syntax.keyword } },
      { scope: ["string.other.link.title.markdown","string.other.link.description.markdown"], settings: { foreground: c.syntax.func } },
      { scope: "punctuation.definition.metadata.markdown", settings: { foreground: c.syntax.tag } },

      { scope: ["markup.inline.raw.markdown","markup.inline.raw.string.markdown"], settings: { foreground: c.syntax.string } },

      { scope: "punctuation.definition.list.begin.markdown", settings: { foreground: c.syntax.tag } },
      { scope: "punctuation.definition.list.markdown", settings: { foreground: c.syntax.tag } },
      { scope: "beginning.punctuation.definition.list.markdown", settings: { foreground: c.syntax.tag } },

      { scope: ["punctuation.definition.string.begin.markdown","punctuation.definition.string.end.markdown"], settings: { foreground: c.syntax.tag } },

      { scope: "markup.quote.markdown", settings: { foreground: c.syntax.comment } },

      { scope: "keyword.other.unit", settings: { foreground: c.syntax.tag } },

      // ========================================
      // DIFF/GIT
      // ========================================
      { scope: "markup.changed.diff", settings: { foreground: c.syntax.namespace } },
      { scope: ["meta.diff.header.from-file","meta.diff.header.to-file","punctuation.definition.from-file.diff","punctuation.definition.to-file.diff"], settings: { foreground: c.syntax.func } },
      { scope: "markup.inserted.diff", settings: { foreground: c.syntax.string } },
      { scope: "markup.deleted.diff", settings: { foreground: c.syntax.tag } },

      // ========================================
      // REGULAR EXPRESSIONS
      // ========================================
      { scope: "string.regexp", settings: { foreground: c.syntax.regexp } },
      { scope: "constant.other.character-class.regexp", settings: { foreground: c.syntax.tag } },
      { scope: "keyword.operator.quantifier.regexp", settings: { foreground: c.syntax.constant } },
      { scope: "constant.character.escape", settings: { foreground: c.syntax.escape } },

      // ========================================
      // JSON
      // ========================================
      { scope: "source.json meta.structure.dictionary.json > string.quoted.json", settings: { foreground: c.syntax.tag } },
      { scope: "source.json meta.structure.dictionary.json > string.quoted.json > punctuation.string", settings: { foreground: c.syntax.tag } },
      { scope: ["source.json meta.structure.dictionary.json > value.json > string.quoted.json","source.json meta.structure.array.json > value.json > string.quoted.json","source.json meta.structure.dictionary.json > value.json > string.quoted.json > punctuation","source.json meta.structure.array.json > value.json > string.quoted.json > punctuation"], settings: { foreground: c.syntax.string } },
      { scope: ["source.json meta.structure.dictionary.json > constant.language.json","source.json meta.structure.array.json > constant.language.json"], settings: { foreground: c.syntax.operator } },
      { scope: "support.type.property-name.json", settings: { foreground: c.syntax.tag } },
      { scope: "support.type.property-name.json punctuation", settings: { foreground: c.syntax.tag } },

      // ========================================
      // YAML
      // ========================================
      { scope: "punctuation.definition.block.sequence.item.yaml", settings: { foreground: c.syntax.punctuation } },

      // ========================================
      // SPECIAL/MISC
      // ========================================
      { scope: "block.scope.end", settings: { foreground: c.syntax.punctuation } },
      { scope: "block.scope.begin", settings: { foreground: c.syntax.punctuation } },

      { scope: "token.info-token", settings: { foreground: c.syntax.func } },
      { scope: "token.warn-token", settings: { foreground: c.syntax.constant } },
      { scope: "token.error-token", settings: { foreground: "#f44747" } },
      { scope: "token.debug-token", settings: { foreground: c.syntax.keyword } },

      // ========================================
      // INVALID/ERROR STATES
      // ========================================
      { scope: "invalid.illegal", settings: { foreground: c.syntax.invalid } },
      { scope: "invalid.broken", settings: { foreground: c.syntax.invalid } },
      { scope: "invalid.deprecated", settings: { foreground: c.syntax.invalid } },
      { scope: "invalid.unimplemented", settings: { foreground: c.syntax.invalid } }
    ],

    semanticTokenColors: {
      comment: c.syntax.comment,
      string: c.syntax.string,
      number: c.syntax.number,
      regexp: c.syntax.regexp,
      keyword: c.syntax.keyword,
      // identifiers
      variable: c.syntax.variable,
      parameter: c.syntax.parameter,
      property: c.syntax.variable,
      // callables / types
      function: c.syntax.func,
      method: c.syntax.func,
      type: c.syntax.type,
      class: c.syntax.type,
      namespace: c.syntax.namespace,
      // constants and special
      enumMember: c.syntax.operator,
      "variable.constant": c.syntax.constant,
      "variable.defaultLibrary": c.syntax.namespace
    }
  };
}

// helpers
function alpha(color: string, opacity: number): string {
  // Handle Display P3 color format
  if (color.startsWith('color(display-p3')) {
    // Extract the existing alpha if present, or insert new one
    if (color.includes(' / ')) {
      // Replace existing alpha
      return color.replace(/ \/ [\d.]+\)$/, ` / ${opacity.toFixed(6)})`);
    } else {
      // Add alpha before closing paren
      return color.replace(/\)$/, ` / ${opacity.toFixed(6)})`);
    }
  }

  // Handle hex color format
  const alphaHex = Math.round(opacity * 255).toString(16).padStart(2, "0");
  return `${color}${alphaHex}`;
}

function hexToRgb(hex: string): [number,number,number] {
  const n = hex.replace("#",""); const v = parseInt(n.length===3 ? n.split("").map(x=>x+x).join("") : n, 16);
  return [(v>>16)&255,(v>>8)&255,v&255];
}

function p3ToRgb(p3Color: string): [number,number,number] {
  // Extract RGB values from color(display-p3 r g b) format
  const match = p3Color.match(/color\(display-p3\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (match) {
    return [parseFloat(match[1]) * 255, parseFloat(match[2]) * 255, parseFloat(match[3]) * 255];
  }
  return [0, 0, 0];
}

function mix(c1: string, c2: string, w=0.5) {
  // Handle Display P3 colors
  if (c1.startsWith('color(display-p3') && c2.startsWith('color(display-p3')) {
    const [r1,g1,b1] = p3ToRgb(c1);
    const [r2,g2,b2] = p3ToRgb(c2);
    const r=Math.round(r1*(1-w)+r2*w), g=Math.round(g1*(1-w)+g2*w), b=Math.round(b1*(1-w)+b2*w);
    // Convert back to P3 format (0-1 range)
    return `color(display-p3 ${(r/255).toFixed(6)} ${(g/255).toFixed(6)} ${(b/255).toFixed(6)})`;
  }

  // Handle hex colors
  const [r1,g1,b1]=hexToRgb(c1), [r2,g2,b2]=hexToRgb(c2);
  const r=Math.round(r1*(1-w)+r2*w), g=Math.round(g1*(1-w)+g2*w), b=Math.round(b1*(1-w)+b2*w);
  return `#${[r,g,b].map(x=>x.toString(16).padStart(2,"0")).join("")}`;
}
