import { Catalog } from "@a2ui/web_core/catalog";
import { effect, getValue } from "@a2ui/web_core/reactivity";
import { isWritable, ResolvedBinding } from "@a2ui/web_core/resolution";
import {
  BASIC_COMPONENTS,
  BASIC_FUNCTIONS,
  BasicCatalogThemeSchema,
  computeColorVariant,
  injectBasicCatalogStyles,
} from "@a2ui/web_core/v0_9/basic_catalog";
import { Dynamic } from "@solidjs/web";
import DOMPurify from "dompurify";
import { Marked } from "marked";
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
import { CatalogDialog, catalogAlignment, catalogInputValue } from "./catalog-primitives.jsx";
import { catalogStyles } from "./catalog-v0.9-styles.js";

// Only the headless schemas/functions reach the bundle. No universal element is registered.
export const basicCatalog = new Catalog(
  "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
  "0.9",
  BASIC_COMPONENTS,
  BASIC_FUNCTIONS,
  BasicCatalogThemeSchema,
);

const tags = {
  Text: "a2ui-basic-text",
  Button: "a2ui-basic-button",
  TextField: "a2ui-basic-textfield",
  Row: "a2ui-basic-row",
  Column: "a2ui-basic-column",
  List: "a2ui-list",
  Image: "a2ui-image",
  Icon: "a2ui-icon",
  Video: "a2ui-video",
  AudioPlayer: "a2ui-audioplayer",
  Card: "a2ui-card",
  Divider: "a2ui-divider",
  CheckBox: "a2ui-checkbox",
  Slider: "a2ui-slider",
  DateTimeInput: "a2ui-datetimeinput",
  ChoicePicker: "a2ui-choicepicker",
  Tabs: "a2ui-tabs",
  Modal: "a2ui-modal",
};
const markdown = new Marked({
  renderer: {
    html: ({ text }) =>
      text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  },
});
const unwrap = (value) => (value instanceof ResolvedBinding ? value.value : value);

// Bridge the processor's synchronous signal owner without replacing its implementation.
export function observeValue(read) {
  const [value, setValue] = createSignal(read());
  onSettled(() => effect(() => setValue(() => read())));
  return value;
}

export function CatalogStyles() {
  onSettled(() => injectBasicCatalogStyles());
  return <style>{catalogStyles}</style>;
}

function ValidationErrors(props) {
  return (
    <Show when={props.data.isValid === false}>
      <For each={props.data.validationErrors ?? []}>
        {(message) => <div class="error a2ui-error-message">{message}</div>}
      </For>
    </Show>
  );
}

function Text(props) {
  const variant = () => props.value("variant") || "body";
  const text = () => String(props.value("text") ?? "");
  const isHeading = () => /^h[1-5]$/.test(variant());
  const html = createMemo(() =>
    DOMPurify.sanitize(markdown.parse(text(), { async: false }), {
      ALLOWED_TAGS: [
        "p",
        "br",
        "em",
        "strong",
        "s",
        "code",
        "pre",
        "blockquote",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
      ],
      ALLOWED_ATTR: [],
    }),
  );
  return (
    <span class={["a2ui-text", variant()]} style={{ flex: props.value("weight") }}>
      <Show when={isHeading() || variant() === "caption"} fallback={<span innerHTML={html()} />}>
        <Dynamic component={isHeading() ? variant() : "em"}>{text()}</Dynamic>
      </Show>
    </span>
  );
}

function ChoicePicker(props) {
  const [filter, setFilter] = createSignal("");
  const group = createUniqueId();
  const selected = () => {
    const value = props.value("value");
    return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  };
  const multi = () => props.data.variant === "multipleSelection";
  const chips = () => props.data.displayStyle === "chips";
  const options = () =>
    (props.data.options ?? []).filter(
      (option) =>
        !props.data.filterable ||
        String(unwrap(option.label)).toLowerCase().includes(filter().toLowerCase()),
    );
  const toggle = (value) =>
    props.write(
      "value",
      multi()
        ? selected().includes(value)
          ? selected().filter((item) => item !== value)
          : [...selected(), value]
        : [value],
    );
  return (
    <>
      <Show when={props.value("label")}>
        <label>{props.value("label")}</label>
      </Show>
      <Show when={props.data.filterable}>
        <input
          type="text"
          class="filter-input"
          placeholder="Filter options..."
          aria-label="Filter options"
          value={filter()}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />
      </Show>
      <div
        class={[
          "a2ui-choice-picker options",
          { "a2ui-options-group": !chips(), "chips a2ui-chips-group": chips() },
        ]}
      >
        <For each={options()} keyed={(option) => option.value}>
          {(option) => (
            <Show
              when={chips()}
              fallback={
                <label class="a2ui-option-label">
                  <input
                    type={multi() ? "checkbox" : "radio"}
                    name={group}
                    value={option().value}
                    checked={selected().includes(option().value)}
                    onChange={() => toggle(option().value)}
                    class="a2ui-option-input"
                  />
                  <span class="a2ui-option-text">{unwrap(option().label)}</span>
                </label>
              }
            >
              <button
                type="button"
                class={[
                  "a2ui-chip chip",
                  {
                    active: selected().includes(option().value),
                    selected: selected().includes(option().value),
                  },
                ]}
                aria-pressed={selected().includes(option().value) ? "true" : "false"}
                onClick={() => toggle(option().value)}
              >
                {unwrap(option().label)}
              </button>
            </Show>
          )}
        </For>
      </div>
      <ValidationErrors data={props.data} />
    </>
  );
}

function Tabs(props) {
  const [selected, setSelected] = createSignal(0);
  const tabs = () => props.data.tabs ?? [];
  const active = () => (selected() < tabs().length ? selected() : 0);
  const group = createUniqueId();
  return (
    <div class="a2ui-tabs">
      <div class="a2ui-tab-bar" role="tablist">
        <For each={tabs()} keyed={(tab) => tab.child.id}>
          {(tab, index) => (
            <button
              type="button"
              class={["a2ui-tab-button", { active: active() === index() }]}
              role="tab"
              aria-selected={active() === index() ? "true" : "false"}
              aria-controls={`${group}-panel`}
              tabindex={active() === index() ? 0 : -1}
              onClick={() => setSelected(index())}
              onKeyDown={(event) => {
                const next = {
                  ArrowRight: (index() + 1) % tabs().length,
                  ArrowLeft: (index() + tabs().length - 1) % tabs().length,
                  Home: 0,
                  End: tabs().length - 1,
                }[event.key];
                if (next === undefined) {
                  return;
                }
                event.preventDefault();
                setSelected(next);
                event.currentTarget.parentElement.children[next].focus();
              }}
            >
              {unwrap(tab().title)}
            </button>
          )}
        </For>
      </div>
      <div id={`${group}-panel`} class="a2ui-tab-content" role="tabpanel">
        <CatalogNode node={tabs()[active()]?.child} />
      </div>
    </div>
  );
}

function Modal(props) {
  return (
    <div class="a2ui-modal-wrapper">
      <CatalogDialog
        triggerClass="a2ui-modal-trigger"
        trigger={<CatalogNode node={props.data.trigger} />}
        class="a2ui-modal-overlay"
      >
        {(close) => (
          <div class="a2ui-modal-content">
            <button type="button" class="a2ui-modal-close" aria-label="Close" onClick={close}>
              ×
            </button>
            <CatalogNode node={props.data.content} />
          </div>
        )}
      </CatalogDialog>
    </div>
  );
}

function DateTimeInput(props) {
  const raw = () => String(props.value("value") ?? "");
  const date = () => (raw().includes("-") ? raw().split("T")[0].slice(0, 10) : "");
  const time = () =>
    (raw().includes("T") ? raw().split("T")[1] : raw().includes(":") ? raw() : "").slice(0, 5);
  const dateValue = catalogInputValue(date);
  const timeValue = catalogInputValue(time);
  const dateEnabled = () => props.data.enableDate ?? true;
  const timeEnabled = () => props.data.enableTime ?? false;
  const dateBound = (key) => String(props.value(key) ?? "").split("T")[0] || undefined;
  const timeBound = (key) => {
    const bound = String(props.value(key) ?? "");
    const parts = bound.split("T");
    // Combined bounds restrict time only on the boundary day, not every day in the range.
    if (dateEnabled() && parts.length > 1 && date() !== parts[0]) {
      return undefined;
    }
    return (parts.length > 1 ? parts[1] : bound).slice(0, 5) || undefined;
  };
  const changeDate = (event) =>
    props.write(
      "value",
      timeEnabled()
        ? `${event.currentTarget.value}T${raw().includes("T") ? raw().split("T")[1] : raw().includes(":") ? raw() : "00:00:00"}`
        : event.currentTarget.value,
    );
  const changeTime = (event) => {
    const today = new Date();
    const currentDate =
      date() ||
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    props.write(
      "value",
      dateEnabled() ? `${currentDate}T${event.currentTarget.value}:00` : event.currentTarget.value,
    );
  };
  return (
    <div class="a2ui-date-time-container">
      <Show when={props.value("label")}>
        <label class="a2ui-date-time-label">{props.value("label")}</label>
      </Show>
      <div class="a2ui-date-time-inputs">
        <Show when={dateEnabled()}>
          <input
            type="date"
            class="a2ui-date-time-input"
            aria-label="Date"
            min={dateBound("min")}
            max={dateBound("max")}
            ref={dateValue}
            onChange={changeDate}
          />
        </Show>
        <Show when={timeEnabled()}>
          <input
            type="time"
            class="a2ui-date-time-input"
            aria-label="Time"
            min={timeBound("min")}
            max={timeBound("max")}
            ref={timeValue}
            onChange={changeTime}
          />
        </Show>
      </div>
      <ValidationErrors data={props.data} />
    </div>
  );
}

export function CatalogNode(props) {
  // A new resolver node means a new component lifetime, including its local interaction state.
  return (
    <Show when={props.node} keyed>
      {(node) => (
        <Show
          when={node.impl}
          fallback={
            <div role="alert">
              {node.isPlaceholder ? "Loading component..." : `Unknown component type: ${node.type}`}
            </div>
          }
        >
          <CatalogElement node={node} />
        </Show>
      )}
    </Show>
  );
}

function CatalogElement(props) {
  const data = observeValue(() => getValue(props.node.props));
  const value = (key) => unwrap(data()[key]);
  const write = (key, next) => {
    const binding = data()[key];
    if (isWritable(binding)) {
      binding.set(next);
    }
  };
  const type = props.node.type;
  const inputId = createUniqueId();
  const variant = () => data().variant ?? "default";
  const invalid = () => data().isValid === false;
  const primary = () => props.node.context.theme?.primaryColor;
  return (
    <Dynamic
      component={tags[type]}
      id={props.node.instanceId}
      aria-label={data().accessibility?.label}
      aria-description={data().accessibility?.description}
      aria-live={data().accessibility?.live}
      aria-hidden={
        data().accessibility?.hidden === undefined ? undefined : String(data().accessibility.hidden)
      }
      style={{
        flex: data().weight,
        "justify-content": catalogAlignment(data().justify),
        "align-items": catalogAlignment(data().align),
        "--a2ui-color-primary": primary(),
        "--a2ui-color-primary-light": primary()
          ? computeColorVariant("light", { colorVar: "--a2ui-color-primary" })
          : undefined,
        "--a2ui-color-primary-dark": primary()
          ? computeColorVariant("dark", { colorVar: "--a2ui-color-primary" })
          : undefined,
        "--a2ui-color-primary-hover": primary()
          ? computeColorVariant("hover", {
              darkVar: "--a2ui-color-primary-dark",
              lightVar: "--a2ui-color-primary-light",
            })
          : undefined,
      }}
    >
      <Switch>
        <Match when={type === "Text"}>
          <Text value={value} />
        </Match>
        <Match when={type === "Icon"}>
          <Show
            when={value("name")?.svgPath}
            fallback={
              <i class="material-icons a2ui-icon">
                {{
                  play: "play_arrow",
                  rewind: "fast_rewind",
                  favoriteOff: "favorite_border",
                  starOff: "star_border",
                }[value("name")] ??
                  String(value("name") ?? "").replace(
                    /[A-Z]/g,
                    (letter) => `_${letter.toLowerCase()}`,
                  )}
              </i>
            }
          >
            <svg class="a2ui-icon svg" viewBox="0 0 24 24">
              <path d={value("name").svgPath} />
            </svg>
          </Show>
        </Match>
        <Match when={type === "Image"}>
          <img
            class={["a2ui-image", variant()]}
            src={value("url")}
            alt={value("description") ?? ""}
            style={{ "object-fit": data().fit ?? "cover" }}
          />
        </Match>
        <Match when={type === "Video"}>
          <div class="a2ui-video-container">
            <video class="a2ui-video" src={value("url") || undefined} controls />
          </div>
        </Match>
        <Match when={type === "AudioPlayer"}>
          <div class="a2ui-audio-player">
            <Show when={value("description")}>
              <div class="a2ui-audio-description">{value("description")}</div>
            </Show>
            <audio class="a2ui-audio" src={value("url") || undefined} controls />
          </div>
        </Match>
        <Match when={type === "Row" || type === "Column"}>
          <For each={data().children ?? []}>{(child) => <CatalogNode node={child} />}</For>
        </Match>
        <Match when={type === "List"}>
          <div class={["a2ui-list", data().direction ?? "vertical"]}>
            <For each={data().children ?? []}>
              {(child) => (
                <div class="a2ui-list-item-none">
                  <CatalogNode node={child} />
                </div>
              )}
            </For>
          </div>
        </Match>
        <Match when={type === "Card"}>
          <div class="a2ui-card">
            <CatalogNode node={data().child} />
          </div>
        </Match>
        <Match when={type === "Button"}>
          <button
            type="button"
            class={["a2ui-button", variant(), `a2ui-button-${variant()}`]}
            disabled={invalid()}
            onClick={() => {
              if (!invalid()) {
                data().action?.();
              }
            }}
          >
            <CatalogNode node={data().child} />
          </button>
        </Match>
        <Match when={type === "CheckBox"}>
          <div class="container">
            <label class={["a2ui-checkbox", { invalid: invalid() }]}>
              <input
                type="checkbox"
                class={{ invalid: invalid() }}
                checked={value("value") || false}
                onChange={(event) => write("value", event.currentTarget.checked)}
              />
              <span class="a2ui-check-box-text">{value("label")}</span>
            </label>
            <ValidationErrors data={data()} />
          </div>
        </Match>
        <Match when={type === "TextField"}>
          <Show when={value("label")}>
            <label for={inputId}>{value("label")}</label>
          </Show>
          <Dynamic
            component={variant() === "longText" ? "textarea" : "input"}
            id={inputId}
            type={
              variant() === "obscured" ? "password" : variant() === "number" ? "number" : "text"
            }
            class={["a2ui-textfield", { invalid: invalid() }]}
            value={value("value") ?? ""}
            onInput={(event) => write("value", event.currentTarget.value)}
          />
          <ValidationErrors data={data()} />
        </Match>
        <Match when={type === "Slider"}>
          <div class="a2ui-slider-container">
            <div class="a2ui-slider-header">
              <label class="a2ui-slider-label" for={inputId}>
                {value("label")}
              </label>
              <span class="a2ui-slider-value">{value("value")}</span>
            </div>
            <input
              id={inputId}
              type="range"
              class="a2ui-slider"
              min={data().min ?? 0}
              max={data().max ?? 100}
              step="any"
              value={value("value") ?? 0}
              onInput={(event) => write("value", event.currentTarget.valueAsNumber)}
            />
            <ValidationErrors data={data()} />
          </div>
        </Match>
        <Match when={type === "Divider"}>
          <hr class={["a2ui-divider", data().axis ?? "horizontal"]} />
        </Match>
        <Match when={type === "ChoicePicker"}>
          <ChoicePicker data={data()} value={value} write={write} />
        </Match>
        <Match when={type === "DateTimeInput"}>
          <DateTimeInput data={data()} value={value} write={write} />
        </Match>
        <Match when={type === "Tabs"}>
          <Tabs data={data()} />
        </Match>
        <Match when={type === "Modal"}>
          <Modal data={data()} />
        </Match>
      </Switch>
    </Dynamic>
  );
}
