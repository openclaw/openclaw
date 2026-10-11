import { decodeHTML, decodeHTMLAttribute } from "entities";
import { JSDOM } from "jsdom";
import * as ts from "typescript/unstable/ast";

type TemplateBindings = {
  expression: (expression: ts.Expression, attribute: boolean) => string;
  attribute: (expression: ts.Expression) => string;
  hasNothing: (expression: ts.Expression) => boolean;
  isClassMap: (expression: ts.Expression) => boolean;
  isStyleMap: (expression: ts.Expression) => boolean;
  hasNestedDirective: (expression: ts.Expression) => boolean;
  hasListenerOptions: (expression: ts.Expression) => boolean;
  svg: boolean;
  directive: (expression: ts.Expression) => void;
};

const voidTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
// Solid 2 rc.13 DOMWithState. Other properties must stay explicit property writes.
const nativeProperties: Record<string, readonly string[]> = {
  input: ["value", "defaultValue", "checked", "defaultChecked"],
  select: ["value"],
  option: ["value", "selected", "defaultSelected"],
  textarea: ["value", "defaultValue"],
  video: ["muted", "defaultMuted"],
  audio: ["muted", "defaultMuted"],
};
const booleanAttributes = new Set(
  "allowfullscreen async autofocus autoplay checked controls default defer disabled formnovalidate hidden inert ismap itemscope loop multiple muted nomodule novalidate open playsinline readonly required reversed selected disablepictureinpicture disableremoteplayback capture".split(
    " ",
  ),
);
const events: Record<string, string> = {
  dblclick: "DblClick",
  keydown: "KeyDown",
  keyup: "KeyUp",
  keypress: "KeyPress",
  mousedown: "MouseDown",
  mouseup: "MouseUp",
  mousemove: "MouseMove",
  mouseenter: "MouseEnter",
  mouseleave: "MouseLeave",
  mouseover: "MouseOver",
  mouseout: "MouseOut",
  contextmenu: "ContextMenu",
  pointerdown: "PointerDown",
  pointerup: "PointerUp",
  pointermove: "PointerMove",
  pointerenter: "PointerEnter",
  pointerleave: "PointerLeave",
  pointercancel: "PointerCancel",
  gotpointercapture: "GotPointerCapture",
  lostpointercapture: "LostPointerCapture",
  focusin: "FocusIn",
  focusout: "FocusOut",
  touchstart: "TouchStart",
  touchend: "TouchEnd",
  touchmove: "TouchMove",
  touchcancel: "TouchCancel",
  dragstart: "DragStart",
  dragend: "DragEnd",
  dragenter: "DragEnter",
  dragleave: "DragLeave",
  dragover: "DragOver",
  compositionstart: "CompositionStart",
  compositionend: "CompositionEnd",
  compositionupdate: "CompositionUpdate",
  beforeinput: "BeforeInput",
  loadedmetadata: "LoadedMetadata",
  timeupdate: "TimeUpdate",
  animationend: "AnimationEnd",
  transitionend: "TransitionEnd",
  pointerover: "PointerOver",
  pointerout: "PointerOut",
  pointerrawupdate: "PointerRawUpdate",
  loadeddata: "LoadedData",
  loadstart: "LoadStart",
  auxclick: "AuxClick",
  canplay: "CanPlay",
  canplaythrough: "CanPlayThrough",
  cuechange: "CueChange",
  durationchange: "DurationChange",
  formdata: "FormData",
  fullscreenchange: "FullscreenChange",
  fullscreenerror: "FullscreenError",
  ratechange: "RateChange",
  volumechange: "VolumeChange",
  animationcancel: "AnimationCancel",
  animationiteration: "AnimationIteration",
  animationstart: "AnimationStart",
  transitioncancel: "TransitionCancel",
  transitionrun: "TransitionRun",
  transitionstart: "TransitionStart",
  beforecopy: "BeforeCopy",
  beforecut: "BeforeCut",
  beforematch: "BeforeMatch",
  beforepaste: "BeforePaste",
  beforetoggle: "BeforeToggle",
  beforexrselect: "BeforeXRSelect",
  beforeprint: "BeforePrint",
  beforeunload: "BeforeUnload",
  contentvisibilityautostatechange: "ContentVisibilityAutoStateChange",
  contextlost: "ContextLost",
  contextrestored: "ContextRestored",
  dragexit: "DragExit",
  scrollend: "ScrollEnd",
  scrollsnapchange: "ScrollSnapChange",
  scrollsnapchanging: "ScrollSnapChanging",
  securitypolicyviolation: "SecurityPolicyViolation",
  selectionchange: "SelectionChange",
  selectstart: "SelectStart",
  slotchange: "SlotChange",
};

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertion(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function needsHostReceiver(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  if (ts.isConditionalExpression(value)) {
    return needsHostReceiver(value.whenTrue) || needsHostReceiver(value.whenFalse);
  }
  if (ts.isBinaryExpression(value)) {
    return needsHostReceiver(value.left) || needsHostReceiver(value.right);
  }
  return (
    (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
    unwrap(value.expression).kind === ts.SyntaxKind.ThisKeyword
  );
}

/** Tokenize literal markup only; TypeScript owns every interpolation, including nested templates. */
export function templateToJsx(
  node: ts.TaggedTemplateExpression,
  bindings: TemplateBindings,
): string {
  const expressions: ts.Expression[] = [];
  const marker = "\uE000";
  const template = node.template;
  const literals = ts.isTemplateExpression(template)
    ? [template.head.text, ...template.templateSpans.map((span) => span.literal.text)]
    : [template.text];
  if (literals.some((literal) => literal.includes(marker))) {
    throw new Error("template contains reserved interpolation marker");
  }
  let input = literals[0]!;
  if (ts.isTemplateExpression(template)) {
    template.templateSpans.forEach((span, index) => {
      expressions.push(span.expression);
      input += `${marker}${index}${marker}${literals[index + 1]}`;
    });
  }
  let cursor = 0;
  const stack: string[] = [];
  const parents: number[] = [];
  const expected: { tag: string; parent: number | null }[] = [];
  const expectedText = new Map<number | null, string>();
  const recordText = (text: string) => {
    const parent = parents.at(-1) ?? null;
    expectedText.set(parent, (expectedText.get(parent) ?? "") + text);
  };
  let output = "<>";
  const interpolation = () => {
    const end = input.indexOf(marker, cursor + 1);
    const expression = expressions[Number(input.slice(cursor + 1, end))];
    if (!expression || end === -1) {
      throw new Error("invalid interpolation");
    }
    cursor = end + 1;
    return expression;
  };
  const whitespace = () => {
    while (/\s/u.test(input[cursor] ?? "") && cursor < input.length) {
      cursor += 1;
    }
  };
  const value = (quote: string | null) => {
    const pieces: (string | ts.Expression)[] = [];
    let literal = "";
    while (cursor < input.length) {
      const char = input[cursor]!;
      if (
        quote
          ? char === quote
          : /[\s>]/u.test(char) ||
            (input.startsWith("/>", cursor) &&
              literal === "" &&
              pieces.some((piece) => typeof piece !== "string"))
      ) {
        break;
      }
      if (char === marker) {
        if (literal) {
          pieces.push(decodeHTMLAttribute(literal));
        }
        literal = "";
        pieces.push(interpolation());
      } else {
        literal += char;
        cursor += 1;
      }
    }
    if (literal) {
      pieces.push(decodeHTMLAttribute(literal));
    }
    if (quote) {
      if (input[cursor] !== quote) {
        throw new Error("unterminated attribute");
      }
      cursor += 1;
    }
    return pieces;
  };
  while (cursor < input.length) {
    if (input[cursor] === marker) {
      if (stack.at(-1) === "textarea") {
        throw new Error("textarea content needs manual value ownership");
      }
      const start = cursor;
      const expression = interpolation();
      recordText(input.slice(start, cursor));
      output += `{${bindings.expression(expression, false)}}`;
      continue;
    }
    if (input.startsWith("<!--", cursor)) {
      const end = input.indexOf("-->", cursor + 4);
      if (end === -1) {
        throw new Error("unterminated HTML comment");
      }
      if (input.slice(cursor, end).includes(marker)) {
        throw new Error("interpolation inside HTML comment");
      }
      output += `{/*${input.slice(cursor + 4, end).replaceAll("*/", "* / ")}*/}`;
      cursor = end + 3;
      continue;
    }
    if (input[cursor] !== "<") {
      const start = cursor;
      while (cursor < input.length && input[cursor] !== "<" && input[cursor] !== marker) {
        cursor += 1;
      }
      if (stack.at(-1) === "textarea" && input.slice(start, cursor).trim()) {
        throw new Error("textarea content needs manual value ownership");
      }
      // JSX folds whitespace. String children preserve Lit's cooked text and entities exactly.
      const text = decodeHTML(input.slice(start, cursor));
      recordText(text);
      output += `{${JSON.stringify(text)}}`;
      continue;
    }
    cursor += 1;
    const closing = input[cursor] === "/";
    if (closing) {
      cursor += 1;
    }
    const match = /^[A-Za-z][\w:.-]*/u.exec(input.slice(cursor));
    if (!match) {
      throw new Error("dynamic tag or unsupported markup");
    }
    const tag = match[0];
    if (/^[A-Z]/u.test(tag)) {
      throw new Error("HTML tag casing needs manual normalization");
    }
    cursor += tag.length;
    if (tag === "script" || tag === "style" || tag === "title") {
      throw new Error(`raw-text element <${tag}> needs manual conversion`);
    }
    if (closing) {
      whitespace();
      if (input[cursor] !== ">" || stack.pop() !== tag) {
        throw new Error("implicit or mismatched closing tag");
      }
      cursor += 1;
      parents.pop();
      output += `</${tag}>`;
      continue;
    }
    output += `<${tag}`;
    const elementIndex = expected.length;
    expected.push({ tag: tag.toLowerCase(), parent: parents.at(-1) ?? null });
    let selfClosing = false;
    let ended = false;
    const attributes = new Set<string>();
    const targets = new Set<string>();
    const claimTarget = (target: string) => {
      if (targets.has(target)) {
        throw new Error(`converted attributes collide at ${target}`);
      }
      targets.add(target);
    };
    while (cursor < input.length) {
      whitespace();
      if (input.startsWith("/>", cursor)) {
        selfClosing = true;
        ended = true;
        cursor += 2;
        break;
      }
      if (input[cursor] === ">") {
        ended = true;
        cursor += 1;
        break;
      }
      if (input[cursor] === marker) {
        bindings.directive(interpolation());
        throw new Error("element directive needs an owned ref factory");
      }
      const attribute = /^[.?@]?[\w:.-]+/u.exec(input.slice(cursor));
      if (!attribute) {
        throw new Error("dynamic or unsupported attribute name");
      }
      const name = attribute[0];
      if (!/^[A-Za-z_$][\w$-]*(?::[A-Za-z_$][\w$-]*)?$/u.test(name.replace(/^[.?@]/u, ""))) {
        throw new Error(`attribute ${name} needs an explicit JSX spread`);
      }
      if (
        ["ref", "children", "innerHTML", "textContent", "innerText", "className"].includes(name) ||
        /^(?:prop|on|use|attr|bool|class|style):/u.test(name) ||
        /^on/iu.test(name)
      ) {
        throw new Error(`reserved JSX attribute ${name} needs manual conversion`);
      }
      if (attributes.has(name)) {
        throw new Error(`duplicate attribute ${name}`);
      }
      attributes.add(name);
      cursor += name.length;
      whitespace();
      if (input[cursor] !== "=") {
        if (/^[.?@]/u.test(name)) {
          throw new Error(`binding ${name} has no value`);
        }
        const defaults: Record<string, string> = {
          checked: "defaultChecked",
          selected: "defaultSelected",
          muted: "defaultMuted",
        };
        if (nativeProperties[tag]?.includes(name) && !defaults[name]) {
          if (name === "value" && ["input", "option"].includes(tag)) {
            claimTarget(tag === "input" ? "defaultValue" : "value");
            output += ` ${tag === "input" ? "defaultValue" : "value"}={""}`;
            continue;
          }
          throw new Error(`bare native state attribute ${name} needs manual conversion`);
        }
        const target = nativeProperties[tag]?.includes(name) ? (defaults[name] ?? name) : name;
        claimTarget(target);
        output += ` ${target}${booleanAttributes.has(name.toLowerCase()) ? "" : '={""}'}`;
        continue;
      }
      cursor += 1;
      whitespace();
      const quote = input[cursor] === '"' || input[cursor] === "'" ? input[cursor++]! : null;
      const pieces = value(quote);
      if (
        ["input", "option"].includes(tag) &&
        name === "value" &&
        pieces.some((piece) => typeof piece !== "string" && bindings.hasNothing(piece))
      ) {
        throw new Error("option value omission needs an attribute binding");
      }
      const soleExpression = pieces.length === 1 && typeof pieces[0] !== "string";
      if (/^[.?@]/u.test(name) && !soleExpression) {
        throw new Error(`compound binding ${name}`);
      }
      let target = name;
      if (!/^[.?@]/u.test(name) && nativeProperties[tag]?.includes(name)) {
        if (tag === "input" && name === "value") {
          target = "defaultValue";
        } else if (tag !== "option" || name !== "value") {
          throw new Error(`native state attribute ${name} needs manual attribute conversion`);
        }
      }
      if (name.startsWith(".")) {
        const property = name.slice(1);
        target = (nativeProperties[tag]?.includes(property) ? "" : "prop:") + property;
      }
      if (name.startsWith("?")) {
        target = name.slice(1);
        if (
          ["ref", "children", "innerHTML", "textContent", "innerText", "className"].includes(
            target,
          ) ||
          target.startsWith("prop:") ||
          /^on/iu.test(target)
        ) {
          throw new Error(`reserved JSX boolean attribute ${target} needs manual conversion`);
        }
        if (nativeProperties[tag]?.includes(target)) {
          const defaults: Record<string, string> = {
            checked: "defaultChecked",
            selected: "defaultSelected",
            muted: "defaultMuted",
          };
          if (!defaults[target]) {
            throw new Error(`native state boolean ${target} needs manual conversion`);
          }
          target = defaults[target]!;
        }
      }
      if (name.startsWith("@")) {
        const event = name.slice(1);
        if (event.includes(":") || event !== event.toLowerCase()) {
          throw new Error(`case-sensitive event ${event} needs a listener ref`);
        }
        let listener = pieces[0];
        if (listener && typeof listener !== "string") {
          listener = unwrap(listener);
        }
        if (listener && typeof listener !== "string" && needsHostReceiver(listener)) {
          throw new Error("method event listener needs its Lit host receiver");
        }
        if (listener && typeof listener !== "string" && bindings.hasListenerOptions(listener)) {
          throw new Error("event listener options need a direct listener binding");
        }
        target = `on${events[event] ?? event[0]!.toUpperCase() + event.slice(1)}`;
      }
      claimTarget(target);
      if (
        pieces.length > 1 &&
        pieces.some((piece) => typeof piece !== "string" && bindings.hasNothing(piece))
      ) {
        throw new Error("compound attribute omission needs manual conversion");
      }
      if (
        pieces.length > 1 &&
        pieces.some(
          (piece) =>
            typeof piece !== "string" &&
            bindings.hasNestedDirective(piece) &&
            !bindings.isClassMap(piece) &&
            !bindings.isStyleMap(piece),
        )
      ) {
        throw new Error("nested compound directive needs a direct binding");
      }
      if (
        name === "style" &&
        pieces.length > 1 &&
        pieces.some((piece) => typeof piece !== "string" && bindings.isStyleMap(piece))
      ) {
        throw new Error("compound styleMap binding needs manual conversion");
      }
      const rendered =
        pieces.length === 0
          ? '""'
          : pieces.length > 1
            ? '"" + ' +
              pieces
                .map((piece) =>
                  typeof piece === "string"
                    ? JSON.stringify(piece)
                    : `((${bindings.expression(piece, true)}) ?? "")`,
                )
                .join(" + ")
            : pieces
                .map((piece) =>
                  typeof piece === "string"
                    ? JSON.stringify(piece)
                    : `(${/^[.?@]/u.test(name) || (name === "class" && bindings.isClassMap(piece)) || (name === "style" && bindings.isStyleMap(piece)) ? bindings.expression(piece, true) : bindings.attribute(piece)})`,
                )
                .join(" + ");
      const wholeClassPieces = pieces.every((piece, index) =>
        typeof piece !== "string"
          ? index === 0 || typeof pieces[index - 1] === "string"
          : (index === 0 || /^\s/u.test(piece)) &&
            (index === pieces.length - 1 || /\s$/u.test(piece)),
      );
      if (
        target === "class" &&
        pieces.length > 1 &&
        !wholeClassPieces &&
        pieces.some((piece) => typeof piece !== "string" && bindings.isClassMap(piece))
      ) {
        throw new Error("compound classMap boundaries need manual conversion");
      }
      if (target === "class" && pieces.length > 1 && wholeClassPieces) {
        output += ` class={[${pieces.map((piece) => (typeof piece === "string" ? JSON.stringify(piece) : bindings.isClassMap(piece) ? bindings.expression(piece, true) : `globalThis.String((${bindings.expression(piece, true)}) ?? "")`)).join(", ")}]}`;
      } else {
        output += ` ${target}={${name.startsWith("?") ? `!!(${rendered})` : rendered}}`;
      }
    }
    if (!ended) {
      throw new Error("unterminated opening tag");
    }
    if (bindings.svg && stack.length === 0 && tag !== "svg" && !attributes.has("xmlns")) {
      output += ' xmlns="http://www.w3.org/2000/svg"';
    }
    if (
      selfClosing &&
      !voidTags.has(tag) &&
      !bindings.svg &&
      !stack.includes("svg") &&
      tag !== "svg"
    ) {
      throw new Error("self-closing non-void HTML needs explicit closing tags");
    }
    if (selfClosing || voidTags.has(tag)) {
      output += " />";
    } else {
      output += ">";
      stack.push(tag);
      parents.push(elementIndex);
    }
  }
  if (stack.length) {
    throw new Error(`unclosed <${stack.at(-1)}>`);
  }
  const fragment = JSDOM.fragment(bindings.svg ? `<svg>${input}</svg>` : input);
  const actual: typeof expected = [];
  const actualText = new Map<number | null, string>();
  const visit = (nodes: NodeListOf<ChildNode>, parent: number | null) => {
    for (const child of nodes) {
      if (child.nodeType === 3) {
        actualText.set(parent, (actualText.get(parent) ?? "") + child.textContent);
      }
      if (child.nodeType !== 1) {
        continue;
      }
      const element = child as Element;
      const index = actual.length;
      actual.push({ tag: element.localName.toLowerCase(), parent });
      visit(
        element.localName === "template" && element.namespaceURI === "http://www.w3.org/1999/xhtml"
          ? (element as HTMLTemplateElement).content.childNodes
          : element.childNodes,
        index,
      );
    }
  };
  visit(bindings.svg ? fragment.firstChild!.childNodes : fragment.childNodes, null);
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    [...new Set([...expectedText.keys(), ...actualText.keys()])].some(
      (parent) => (expectedText.get(parent) ?? "") !== (actualText.get(parent) ?? ""),
    )
  ) {
    throw new Error("markup needs HTML-parser repair before JSX conversion");
  }
  return output + "</>";
}
