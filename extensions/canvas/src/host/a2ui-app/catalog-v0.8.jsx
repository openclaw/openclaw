import { isSafeRegex } from "@a2ui/web_core/v0_8";
import { Dynamic } from "@solidjs/web";
import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  createUniqueId,
  onSettled,
} from "solid-js";

const tags = Object.fromEntries(
  "Text Image Icon Video AudioPlayer Row Column List Card Tabs Divider Modal Button CheckBox TextField DateTimeInput MultipleChoice Slider"
    .split(" ")
    .map((name) => [name, `a2ui-${name.toLowerCase()}`]),
);
const alignment = (value) =>
  ({
    start: "flex-start",
    end: "flex-end",
    spaceAround: "space-around",
    spaceBetween: "space-between",
    spaceEvenly: "space-evenly",
  })[value] ?? value;

// The processor owns path normalization and template data contexts; the view only reads bindings.
function readValue(props, value) {
  void props.revision;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  for (const key of [
    "literalString",
    "literalNumber",
    "literalBoolean",
    "literalArray",
    "literal",
  ]) {
    if (Object.hasOwn(value, key)) {
      return value[key];
    }
  }
  return typeof value.path === "string"
    ? props.processor.getData(props.node, value.path, props.surfaceId)
    : undefined;
}

function writeValue(props, binding, value) {
  if (typeof binding?.path !== "string") {
    return;
  }
  props.processor.setData(props.node, binding.path, value, props.surfaceId);
  props.onDataChange();
}

function InputField(props) {
  const inputId = createUniqueId();
  const value = createMemo(() => props.value ?? "");
  const pattern = createMemo(() =>
    props.pattern && isSafeRegex(props.pattern) ? props.pattern : undefined,
  );
  return (
    <section class="field">
      <Show when={props.label}>
        <label for={inputId}>{props.label}</label>
      </Show>
      <input
        id={inputId}
        name="data"
        autocomplete="off"
        type={props.type}
        prop:value={value()}
        pattern={pattern()}
        placeholder={props.placeholder}
        onInput={(event) =>
          props.onInput(event.currentTarget.value, event.currentTarget.checkValidity(), event)
        }
      />
    </section>
  );
}

function Choice(props) {
  const [filter, setFilter] = createSignal("");
  const choices = () => props.node.properties;
  const selected = () => {
    const value = readValue(props, choices().selections);
    return Array.isArray(value) ? value : [];
  };
  const options = () =>
    (choices().options ?? []).filter((option) =>
      String(readValue(props, option.label) ?? "")
        .toLowerCase()
        .includes(filter().toLowerCase()),
    );
  const toggle = (value) => {
    const current = selected();
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    if (
      choices().maxAllowedSelections !== undefined &&
      next.length > choices().maxAllowedSelections
    ) {
      return;
    }
    writeValue(props, choices().selections, next);
  };
  return (
    <div class="container">
      <Dynamic component={choices().variant === "chips" ? "div" : "details"}>
        <Show when={choices().variant !== "chips"}>
          <summary class="dropdown-header">
            <span class="header-text">
              {selected().length ? `${selected().length} Selected` : "Select items"}
            </span>
            <span class="chevron">⌄</span>
          </summary>
        </Show>
        <div class={["dropdown-wrapper", { open: choices().variant === "chips" }]}>
          <Show when={choices().filterable}>
            <div class="filter-container">
              <input
                class="filter-input"
                placeholder="Filter options..."
                aria-label="Filter options"
                prop:value={filter()}
                onInput={(event) => setFilter(event.currentTarget.value)}
              />
            </div>
          </Show>
          <div
            class={choices().variant === "chips" ? "chips-container" : "options-scroll-container"}
          >
            <For each={options()} keyed={(option) => option.value}>
              {(option) => (
                <button
                  type="button"
                  class={[
                    choices().variant === "chips" ? "chip" : "option-item",
                    { selected: selected().includes(option().value) },
                  ]}
                  aria-pressed={selected().includes(option().value) ? "true" : "false"}
                  onClick={() => toggle(option().value)}
                >
                  <span class="checkbox-icon" aria-hidden="true">
                    {selected().includes(option().value) ? "✓" : ""}
                  </span>
                  <span>{readValue(props, option().label)}</span>
                </button>
              )}
            </For>
            <Show when={options().length === 0}>
              <div>No options found</div>
            </Show>
          </div>
        </div>
      </Dynamic>
    </div>
  );
}

function Tabs(props) {
  const groupId = createUniqueId();
  const [selected, setSelected] = createSignal(0);
  const items = () => props.node.properties.tabItems ?? [];
  const active = () => Math.min(selected(), Math.max(0, items().length - 1));
  return (
    <section>
      <div class="controls" role="tablist">
        <For each={items()} keyed={(item) => `${item.child.id}:${item.child.dataContextPath}`}>
          {(item, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={active() === index() ? "true" : "false"}
              id={`${groupId}-tab-${index()}`}
              aria-controls={`${groupId}-panel-${index()}`}
              tabindex={active() === index() ? 0 : -1}
              onKeyDown={(event) => {
                const count = items().length;
                const next = {
                  ArrowRight: (index() + 1) % count,
                  ArrowLeft: (index() + count - 1) % count,
                  Home: 0,
                  End: count - 1,
                }[event.key];
                if (next === undefined) {
                  return;
                }
                event.preventDefault();
                setSelected(next);
                event.currentTarget.parentElement.children[next].focus();
              }}
              onClick={() => setSelected(index())}
            >
              {readValue(props, item().title)}
            </button>
          )}
        </For>
      </div>
      <For each={items()} keyed={(item) => `${item.child.id}:${item.child.dataContextPath}`}>
        {(item, index) => (
          <div
            role="tabpanel"
            id={`${groupId}-panel-${index()}`}
            aria-labelledby={`${groupId}-tab-${index()}`}
            hidden={active() !== index()}
          >
            <CatalogNode {...props} node={item().child} />
          </div>
        )}
      </For>
    </section>
  );
}

function Modal(props) {
  let dialog;
  onSettled(() => () => {
    if (dialog?.open) {
      dialog.close();
    }
  });
  return (
    <>
      <section onClick={() => dialog.showModal()}>
        <CatalogNode {...props} node={props.node.properties.entryPointChild} />
      </section>
      <dialog
        ref={(element) => {
          dialog = element;
        }}
        onClick={(event) => {
          if (event.target === dialog) {
            dialog.close();
          }
        }}
      >
        <section class="modal-content">
          <div id="controls">
            <button type="button" aria-label="Close dialog" onClick={() => dialog.close()}>
              ×
            </button>
          </div>
          <CatalogNode {...props} node={props.node.properties.contentChild} />
        </section>
      </dialog>
    </>
  );
}

function localDate(value, type) {
  if (!value) {
    return "";
  }
  // Native input values already describe local wall time, not UTC instants.
  const nativeFormat = {
    date: /^\d{4}-\d{2}-\d{2}$/,
    time: /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/,
    "datetime-local": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/,
  };
  if (nativeFormat[type].test(value)) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (part) => String(part).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return type === "date" ? day : type === "time" ? time : `${day}T${time}`;
}

export function CatalogNode(props) {
  return (
    <For
      each={props.node ? [props.node] : []}
      keyed={(node) => `${node.id}:${node.dataContextPath}`}
    >
      {(node) => <CatalogElement {...props} node={node()} />}
    </For>
  );
}

function CatalogElement(props) {
  const fieldId = createUniqueId();
  const type = () => props.node.type;
  const data = () => props.node.properties;
  const value = (key) => readValue(props, data()[key]);
  const text = () => {
    const content = String(value("text") ?? "");
    const hint = data().usageHint ?? "";
    // Canvas never installed the optional markdown renderer; retain its visible fallback.
    return /^h[1-5]$/.test(hint)
      ? `${"#".repeat(Number(hint[1]))} ${content}`
      : hint === "caption"
        ? `*${content}*`
        : content;
  };
  const dateType = () =>
    data().enableDate !== false && data().enableTime === false
      ? "date"
      : data().enableDate === false && data().enableTime !== false
        ? "time"
        : "datetime-local";
  const children = () => data().children ?? (data().child ? [data().child] : []);
  return (
    <Dynamic
      component={tags[type()] ?? "a2ui-unknown"}
      id={props.node.id}
      slot={props.node.slotName}
      usage-hint={data().usageHint}
      direction={type() === "List" ? (data().direction ?? "vertical") : undefined}
      style={{ "--weight": props.node.weight ?? "initial" }}
    >
      <Switch>
        <Match when={type() === "Text"}>
          <div class={["text", data().usageHint ?? "body"]}>
            <span class="no-markdown-renderer">{text()}</span>
          </div>
        </Match>
        <Match when={type() === "Image"}>
          <img
            src={value("url")}
            alt={value("altText") ?? ""}
            style={{ "object-fit": data().fit ?? "fill" }}
          />
        </Match>
        <Match when={type() === "Icon"}>
          <section>
            <span class="g-icon">
              {String(value("name") ?? "")
                .replace(/([A-Z])/g, "_$1")
                .toLowerCase()}
            </span>
          </section>
        </Match>
        <Match when={type() === "Video"}>
          <video controls src={value("url")} />
        </Match>
        <Match when={type() === "AudioPlayer"}>
          <audio controls src={value("url")} aria-label={value("description")} />
        </Match>
        <Match when={["Row", "Column", "List", "Card"].includes(type())}>
          <section
            style={{
              display: type() === "Card" ? "block" : "flex",
              "flex-direction":
                type() === "Row" || (type() === "List" && data().direction === "horizontal")
                  ? "row"
                  : "column",
              "align-items": alignment(
                data().alignment ?? (type() === "Row" ? "center" : "stretch"),
              ),
              "justify-content": alignment(data().distribution ?? "start"),
            }}
          >
            <For each={children()} keyed={(child) => `${child.id}:${child.dataContextPath}`}>
              {(child) => <CatalogNode {...props} node={child()} />}
            </For>
          </section>
        </Match>
        <Match when={type() === "Button"}>
          <button
            type="button"
            onClick={(event) => {
              if (!data().action) {
                return;
              }
              const payload = {
                eventType: "a2ui.action",
                surfaceId: props.surfaceId,
                sourceComponentId: props.node.id,
                sourceComponent: props.node,
                dataContextPath: props.node.dataContextPath,
                action: data().action,
              };
              event.currentTarget.parentElement.dispatchEvent(
                Object.assign(
                  new CustomEvent("a2uiaction", {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    detail: payload,
                  }),
                  { payload },
                ),
              );
            }}
          >
            <CatalogNode {...props} node={data().child} />
          </button>
        </Match>
        <Match when={type() === "CheckBox"}>
          <section class="checkbox-field">
            <input
              id={fieldId}
              type="checkbox"
              prop:checked={Boolean(value("value"))}
              onInput={(event) => writeValue(props, data().value, event.currentTarget.checked)}
            />
            <label for={fieldId}>{value("label")}</label>
          </section>
        </Match>
        <Match when={type() === "TextField"}>
          <InputField
            id={props.node.id}
            label={value("label")}
            value={value("text")}
            pattern={data().validationRegexp}
            placeholder="Please enter a value"
            type={
              { obscured: "password", number: "number", date: "date" }[data().textFieldType] ??
              "text"
            }
            onInput={(next, valid, event) => {
              event.currentTarget.dispatchEvent(
                new CustomEvent("a2ui-validation-input", {
                  bubbles: true,
                  composed: true,
                  detail: {
                    eventType: "a2ui-validation-input",
                    componentId: props.node.id,
                    value: next,
                    valid,
                  },
                }),
              );
              writeValue(props, data().text, next);
            }}
          />
        </Match>
        <Match when={type() === "DateTimeInput"}>
          <InputField
            id={props.node.id}
            label={dateType() === "date" ? "Date" : dateType() === "time" ? "Time" : "Date & Time"}
            type={dateType()}
            value={localDate(value("value"), dateType())}
            onInput={(next) => writeValue(props, data().value, next)}
          />
        </Match>
        <Match when={type() === "Slider"}>
          <section class="field">
            <Show when={value("label")}>
              <label for={fieldId}>{value("label")}</label>
            </Show>
            <input
              id={fieldId}
              type="range"
              min={data().minValue ?? 0}
              max={data().maxValue ?? 100}
              prop:value={value("value") ?? 0}
              onInput={(event) =>
                writeValue(props, data().value, event.currentTarget.valueAsNumber)
              }
            />
            <output for={fieldId}>{value("value") ?? 0}</output>
          </section>
        </Match>
        <Match when={type() === "Divider"}>
          <hr
            style={{
              width: data().axis === "vertical" ? `${data().thickness ?? 1}px` : "100%",
              height: data().axis === "vertical" ? "100%" : `${data().thickness ?? 1}px`,
              "background-color": data().color,
            }}
          />
        </Match>
        <Match when={type() === "MultipleChoice"}>
          <Choice {...props} />
        </Match>
        <Match when={type() === "Tabs"}>
          <Tabs {...props} />
        </Match>
        <Match when={type() === "Modal"}>
          <Modal {...props} />
        </Match>
      </Switch>
    </Dynamic>
  );
}

export const catalogStyles = `
openclaw-a2ui-host a2ui-surface { display:flex; flex-direction:column; gap:16px; min-width:0; }
openclaw-a2ui-host :is(a2ui-text,a2ui-image,a2ui-icon,a2ui-video,a2ui-audioplayer,a2ui-row,a2ui-column,a2ui-list,a2ui-card,a2ui-tabs,a2ui-divider,a2ui-modal,a2ui-button,a2ui-checkbox,a2ui-textfield,a2ui-datetimeinput,a2ui-multiplechoice,a2ui-slider) { display:block; min-width:0; box-sizing:border-box; flex:var(--weight); }
openclaw-a2ui-host :is(a2ui-row,a2ui-column,a2ui-list) > section { gap:10px; min-width:0; }
openclaw-a2ui-host a2ui-list[direction="horizontal"] > section { max-width:100%; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; }
openclaw-a2ui-host a2ui-list[direction="horizontal"] > section > * { flex:1 0 fit-content; max-width:min(80%,400px); }
openclaw-a2ui-host a2ui-card > section { background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03)); border:1px solid rgba(255,255,255,.09); border-radius:14px; padding:14px; box-shadow:0 10px 30px rgba(0,0,0,.35); }
openclaw-a2ui-host a2ui-button > button { background:linear-gradient(135deg,#22c55e 0%,#06b6d4 100%); border:0; border-radius:12px; padding:10px 14px; color:#071016; font-weight:650; cursor:pointer; box-shadow:0 10px 25px rgba(6,182,212,.18); }
openclaw-a2ui-host button { font:inherit; }
openclaw-a2ui-host a2ui-text .text { font-size:13px; line-height:1.4; white-space:pre-wrap; overflow-wrap:anywhere; }
openclaw-a2ui-host a2ui-text .h1 { font-size:20px; font-weight:750; margin:0 0 6px; }
openclaw-a2ui-host a2ui-text .h2 { font-size:16px; font-weight:700; margin:0 0 6px; }
openclaw-a2ui-host a2ui-text .caption { opacity:.8; }
openclaw-a2ui-host a2ui-image img { display:block; width:100%; max-width:100%; border-radius:12px; }
openclaw-a2ui-host :is(video,audio) { max-width:100%; }
openclaw-a2ui-host .field { display:grid; gap:6px; }
openclaw-a2ui-host .field input { box-sizing:border-box; width:100%; font:inherit; }
openclaw-a2ui-host .field input:invalid { outline-color:var(--danger,#f87171); }
openclaw-a2ui-host .checkbox-field { display:flex; gap:6px; align-items:center; }
openclaw-a2ui-host a2ui-divider hr { border:0; background:#ccc; opacity:.25; }
openclaw-a2ui-host a2ui-tabs .controls { display:flex; gap:6px; margin-bottom:10px; }
openclaw-a2ui-host a2ui-tabs [role=tab][aria-selected=true] { font-weight:700; }
openclaw-a2ui-host a2ui-modal dialog { padding:24px; border:0; background:transparent; color:inherit; max-width:100vw; max-height:100vh; }
openclaw-a2ui-host a2ui-modal dialog::backdrop { background:rgba(5,8,16,.65); backdrop-filter:blur(6px); }
openclaw-a2ui-host a2ui-modal .modal-content { box-sizing:border-box; background:rgba(12,16,24,.92); border:1px solid rgba(255,255,255,.12); border-radius:16px; padding:16px; box-shadow:0 30px 80px rgba(0,0,0,.6); width:min(520px,calc(100vw - 48px)); }
openclaw-a2ui-host a2ui-modal #controls { display:flex; justify-content:flex-end; margin-bottom:4px; }
openclaw-a2ui-host a2ui-modal #controls button { background:none; border:0; color:inherit; font-size:24px; cursor:pointer; }
openclaw-a2ui-host a2ui-multiplechoice .container { display:flex; flex-direction:column; gap:8px; }
openclaw-a2ui-host a2ui-multiplechoice .dropdown-header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border:1px solid currentColor; border-radius:8px; cursor:pointer; }
openclaw-a2ui-host a2ui-multiplechoice :is(.dropdown-wrapper,.options-scroll-container) { display:flex; flex-direction:column; gap:6px; }
openclaw-a2ui-host a2ui-multiplechoice .dropdown-wrapper { margin-top:4px; }
openclaw-a2ui-host a2ui-multiplechoice .options-scroll-container { max-height:300px; overflow:auto; }
openclaw-a2ui-host a2ui-multiplechoice .chips-container { display:flex; flex-wrap:wrap; gap:6px; }
openclaw-a2ui-host a2ui-multiplechoice :is(.chip,.option-item) { display:flex; gap:6px; align-items:center; padding:8px 12px; border:1px solid currentColor; background:transparent; color:inherit; text-align:start; cursor:pointer; }
openclaw-a2ui-host a2ui-multiplechoice .chip { border-radius:999px; }
openclaw-a2ui-host a2ui-multiplechoice .selected { background:rgba(6,182,212,.2); }
openclaw-a2ui-host a2ui-multiplechoice .checkbox-icon { min-width:1em; }
openclaw-a2ui-host .g-icon { font-family:"Material Symbols Outlined"; font-size:24px; font-weight:normal; line-height:1; font-feature-settings:"liga"; }
@media (max-width:860px) { openclaw-a2ui-host a2ui-row > section { flex-wrap:wrap; } openclaw-a2ui-host a2ui-row > section > * { flex:1 1 100%; min-width:100%; } }
`;
