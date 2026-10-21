/*
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Styles adapted from @a2ui/web_core 0.13.0 basic catalog.
// Keep the upstream tags, classes, and customization variables without loading its Lit elements.
export const catalogStyles = `
a2ui-basic-text { display: contents; }
a2ui-basic-text .a2ui-text p, a2ui-basic-text .a2ui-text h1, a2ui-basic-text .a2ui-text h2, a2ui-basic-text .a2ui-text h3, a2ui-basic-text .a2ui-text h4, a2ui-basic-text .a2ui-text h5, a2ui-basic-text .a2ui-text h6, a2ui-basic-text .a2ui-text ol, a2ui-basic-text .a2ui-text ul, a2ui-basic-text .a2ui-text li, a2ui-basic-text .a2ui-text blockquote, a2ui-basic-text .a2ui-text pre { margin: var(--_a2ui-text-margin, 0); }
a2ui-basic-text .a2ui-text { color: var(--_a2ui-text-color, var(--a2ui-text-color-text, var(--a2ui-color-on-background))); }
a2ui-basic-text .a2ui-text h1, a2ui-basic-text .a2ui-text h2, a2ui-basic-text .a2ui-text h3, a2ui-basic-text .a2ui-text h4, a2ui-basic-text .a2ui-text h5, a2ui-basic-text .a2ui-text h6 { font-family: var(--a2ui-font-family-title, inherit); line-height: var(--a2ui-line-height-headings, 1.2); }
a2ui-basic-text .a2ui-text h1 { font-size: var(--a2ui-font-size-2xl); }
a2ui-basic-text .a2ui-text h2 { font-size: var(--a2ui-font-size-xl); }
a2ui-basic-text .a2ui-text h3 { font-size: var(--a2ui-font-size-l); }
a2ui-basic-text .a2ui-text p, a2ui-basic-text .a2ui-text h4 { font-size: var(--a2ui-font-size-m); }
a2ui-basic-text .a2ui-text h5 { font-size: var(--a2ui-font-size-s); }
a2ui-basic-text .a2ui-text p { line-height: var(--a2ui-line-height-body, 1.5); }
a2ui-basic-text .a2ui-text.caption, a2ui-basic-text .a2ui-caption { font-size: var(--a2ui-font-size-xs); color: var(--a2ui-text-caption-color, light-dark(#666, #aaa)); }
a2ui-basic-text .a2ui-text a { color: var(--a2ui-text-a-color, inherit); font-weight: var(--a2ui-text-a-font-weight, inherit); }
a2ui-basic-button .a2ui-button { padding: var( --a2ui-button-padding, var(--a2ui-spacing-m, 0.5rem) var(--a2ui-spacing-l, 1rem) ); border-radius: var(--a2ui-button-border-radius, var(--a2ui-spacing-s, 0.25rem)); border: var( --a2ui-button-border, var(--a2ui-border-width, 1px) solid var(--a2ui-color-border, #ccc) ); cursor: pointer; margin: var(--a2ui-button-margin, var(--a2ui-spacing-m, 0.5rem)); background: var(--a2ui-button-background, var(--a2ui-color-surface, #fff)); box-shadow: var(--a2ui-button-box-shadow, none); font-weight: var(--a2ui-button-font-weight, normal); --_a2ui-text-margin: 0; --_a2ui-text-color: var(--a2ui-color-on-secondary, #333); color: var(--_a2ui-text-color); }
a2ui-basic-button .a2ui-button:hover { background-color: var(--a2ui-color-secondary-hover, #ddd); }
a2ui-basic-button .a2ui-button.primary { background: var(--a2ui-color-primary, #17e); --_a2ui-text-color: var(--a2ui-color-on-primary, #fff); color: var(--_a2ui-text-color); border: none; }
a2ui-basic-button .a2ui-button.primary:hover { background-color: var(--a2ui-color-primary-hover, #fbd); }
a2ui-basic-button .a2ui-button.borderless { background: none; border: none; padding: 0; color: var(--a2ui-color-primary, #17e); }
a2ui-basic-button .a2ui-button:disabled { cursor: not-allowed; opacity: 0.5; }
a2ui-basic-textfield, a2ui-basic-textfield { display: flex; flex-direction: column; width: var(--a2ui-textfield-width, 100%); gap: var(--a2ui-spacing-xs, 0.25rem); }
a2ui-basic-textfield .a2ui-textfield { box-sizing: border-box; width: 100%; background-color: var(--a2ui-color-input, #fff); color: var(--a2ui-color-on-input, #333); border: var(--a2ui-textfield-border, var(--a2ui-border)); border-radius: var(--a2ui-textfield-border-radius, var(--a2ui-spacing-m)); padding: var(--a2ui-textfield-padding, var(--a2ui-spacing-m)); font-family: inherit; }
a2ui-basic-textfield .a2ui-textfield:focus { outline: none; border-color: var(--a2ui-textfield-color-border-focus, var(--a2ui-color-primary, #17e)); }
a2ui-basic-textfield .a2ui-textfield.invalid { border-color: var(--a2ui-textfield-color-error, red); }
a2ui-basic-textfield label { font-size: var( --a2ui-textfield-label-font-size, var(--a2ui-label-font-size, var(--a2ui-font-size-s)) ); font-weight: var(--a2ui-textfield-label-font-weight, var(--a2ui-label-font-weight, bold)); }
a2ui-basic-textfield .error { color: var(--a2ui-textfield-color-error, red); font-size: var(--a2ui-font-size-xs, 0.75rem); }
a2ui-basic-row, a2ui-basic-row { display: flex; flex-direction: row; gap: var(--a2ui-row-gap, var(--a2ui-spacing-m)); }
a2ui-basic-column, a2ui-basic-column { display: flex; flex-direction: column; width: var(--a2ui-column-width, 100%); gap: var(--a2ui-column-gap, var(--a2ui-spacing-m)); }
a2ui-list .a2ui-list { display: flex; padding-inline-start: var(--a2ui-list-padding, var(--a2ui-spacing-l, 24px)); margin: 0; }
a2ui-list .a2ui-list.vertical { flex-direction: column; gap: var(--a2ui-list-gap, var(--a2ui-spacing-s, 8px)); }
a2ui-list .a2ui-list.horizontal { flex-direction: row; gap: var(--a2ui-list-gap, var(--a2ui-spacing-m, 16px)); list-style-position: inside; }
a2ui-list .a2ui-list-item-none { display: block; }
a2ui-list .horizontal .a2ui-list-item-none { display: inline-block; }
a2ui-image .a2ui-image { display: block; max-width: 100%; height: auto; border-radius: var(--a2ui-image-border-radius, 0); }
a2ui-image .a2ui-image.icon { width: var(--a2ui-image-icon-size, 24px); height: var(--a2ui-image-icon-size, 24px); }
a2ui-image .a2ui-image.avatar { width: var(--a2ui-image-avatar-size, 40px); height: var(--a2ui-image-avatar-size, 40px); border-radius: 50%; }
a2ui-image .a2ui-image.smallFeature { max-width: var(--a2ui-image-small-feature-size, 100px); }
a2ui-image .a2ui-image.largeFeature { max-height: var(--a2ui-image-large-feature-size, 400px); }
a2ui-image .a2ui-image.header { height: var(--a2ui-image-header-size, 200px); }
a2ui-icon .a2ui-icon { display: inline-block; width: var(--a2ui-icon-size, 24px); height: var(--a2ui-icon-size, 24px); font-size: var(--a2ui-icon-size, 24px); font-style: normal; font-weight: normal; font-family: var(--a2ui-icon-font-family, 'Material Icons', 'Material Symbols Outlined'); color: var( --a2ui-icon-color, var(--a2ui-text-color-text, var(--a2ui-color-on-background, #333)) ); font-variation-settings: var(--a2ui-icon-font-variation-settings, 'FILL' 1); line-height: 1; text-transform: none; letter-spacing: normal; word-wrap: normal; white-space: nowrap; direction: ltr; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; -moz-osx-font-smoothing: grayscale; font-feature-settings: 'liga'; vertical-align: middle; }
a2ui-icon .a2ui-icon.svg { fill: currentColor; }
a2ui-video .a2ui-video-container { width: 100%; max-width: 100%; }
a2ui-video .a2ui-video { width: 100%; height: auto; display: block; border-radius: var(--a2ui-video-border-radius, 0); }
a2ui-audioplayer .a2ui-audio-player { display: flex; flex-direction: column; gap: var(--a2ui-spacing-xs, 0.25rem); background: var(--a2ui-audioplayer-background, transparent); border-radius: var(--a2ui-audioplayer-border-radius, 0); padding: var(--a2ui-audioplayer-padding, 0); width: 100%; }
a2ui-audioplayer .a2ui-audio-description { font-size: var(--a2ui-font-size-s, 0.875rem); color: var( --a2ui-audioplayer-description-color, var(--a2ui-text-caption-color, light-dark(#666, #aaa)) ); }
a2ui-audioplayer .a2ui-audio { width: 100%; }
a2ui-card .a2ui-card { padding: var(--a2ui-card-padding, var(--a2ui-spacing-m, 16px)); border-radius: var(--a2ui-card-border-radius, var(--a2ui-border-radius, 8px)); box-shadow: var(--a2ui-card-box-shadow, 0 2px 4px rgba(0, 0, 0, 0.1)); background: var(--a2ui-card-background, var(--a2ui-color-surface, #fff)); color: var(--a2ui-color-on-surface, #333); border: var( --a2ui-card-border, var(--a2ui-border-width, 1px) solid var(--a2ui-color-border, #ccc) ); margin: var(--a2ui-card-margin, var(--a2ui-spacing-m, 16px)); }
a2ui-divider .a2ui-divider { border: 0; border-top: var( --a2ui-divider-border, var(--a2ui-border-width, 1px) solid var(--a2ui-color-border, #ccc) ); margin: var(--a2ui-divider-spacing, var(--a2ui-spacing-m, 16px)) 0; width: 100%; }
a2ui-divider .a2ui-divider.vertical { width: var(--a2ui-border-width, 1px); height: 100%; margin: 0 var(--a2ui-divider-spacing, var(--a2ui-spacing-m, 16px)); border-top: 0; border-left: var( --a2ui-divider-border, var(--a2ui-border-width, 1px) solid var(--a2ui-color-border, #ccc) ); }
a2ui-checkbox, a2ui-checkbox { display: block; }
a2ui-checkbox .container { display: flex; flex-direction: column; margin: var(--a2ui-checkbox-margin, var(--a2ui-spacing-m)); }
a2ui-checkbox label.a2ui-checkbox { display: inline-flex; align-items: center; gap: var(--a2ui-checkbox-gap, var(--a2ui-spacing-s, 0.5rem)); font-size: var( --a2ui-checkbox-label-font-size, var(--a2ui-label-font-size, var(--a2ui-font-size-s)) ); font-weight: var(--a2ui-checkbox-label-font-weight, var(--a2ui-label-font-weight, bold)); cursor: pointer; }
a2ui-checkbox label.invalid { color: var(--a2ui-checkbox-color-error, red); }
a2ui-checkbox input { width: var(--a2ui-checkbox-size, 1rem); height: var(--a2ui-checkbox-size, 1rem); background: var(--a2ui-checkbox-background, inherit); border: var(--a2ui-checkbox-border, var(--a2ui-border)); border-radius: var(--a2ui-checkbox-border-radius, 4px); }
a2ui-checkbox input.invalid { outline: 1px solid var(--a2ui-checkbox-color-error, red); }
a2ui-checkbox .error, a2ui-checkbox .a2ui-error-message { color: var(--a2ui-checkbox-color-error, red); font-size: var(--a2ui-font-size-xs, 0.75rem); margin-top: 4px; }
a2ui-slider .a2ui-slider-container { width: 100%; display: flex; flex-direction: column; gap: var(--a2ui-spacing-xs, 4px); margin: var(--a2ui-slider-margin, var(--a2ui-spacing-m, 16px)); }
a2ui-slider .a2ui-slider-header { display: flex; justify-content: space-between; font-size: var( --a2ui-slider-label-font-size, var(--a2ui-label-font-size, var(--a2ui-font-size-s, 14px)) ); font-weight: var(--a2ui-slider-label-font-weight, bold); color: var(--a2ui-text-color-text, var(--a2ui-color-on-background, #333)); }
a2ui-slider .a2ui-slider { width: 100%; cursor: pointer; accent-color: var(--a2ui-slider-thumb-color, var(--a2ui-color-primary, #007bff)); background: var(--a2ui-slider-track-color, var(--a2ui-color-secondary, #e9ecef)); }
a2ui-slider .error, a2ui-slider .a2ui-error-message { color: var(--a2ui-slider-color-error, red); font-size: var(--a2ui-font-size-xs, 0.75rem); }
a2ui-datetimeinput .a2ui-date-time-container { display: flex; flex-direction: column; gap: var(--a2ui-spacing-xs, 4px); width: var(--a2ui-datetimeinput-width, 100%); }
a2ui-datetimeinput input { box-sizing: border-box; width: 100%; }
a2ui-datetimeinput .a2ui-date-time-label { font-size: var( --a2ui-datetimeinput-label-font-size, var(--a2ui-label-font-size, var(--a2ui-font-size-s, 14px)) ); font-weight: var(--a2ui-datetimeinput-label-font-weight, bold); color: var(--a2ui-text-color-text, var(--a2ui-color-on-background, #333)); }
a2ui-datetimeinput .a2ui-date-time-inputs { display: flex; gap: var(--a2ui-spacing-s, 8px); width: 100%; }
a2ui-datetimeinput .a2ui-date-time-input { padding: var(--a2ui-datetimeinput-padding, 8px); border-radius: var(--a2ui-datetimeinput-border-radius, 4px); border: var(--a2ui-datetimeinput-border, 1px solid var(--a2ui-color-border, #ccc)); background-color: var(--a2ui-datetimeinput-background, var(--a2ui-color-input, #fff)); color: var(--a2ui-datetimeinput-color, var(--a2ui-color-on-input, #333)); font-family: inherit; flex: 1; }
a2ui-datetimeinput .a2ui-date-time-input::-webkit-datetime-edit, a2ui-datetimeinput .a2ui-date-time-input::-webkit-datetime-edit-fields-wrapper { color: var(--a2ui-datetimeinput-color, var(--a2ui-color-on-input, #333)); }
a2ui-datetimeinput .error, a2ui-datetimeinput .a2ui-error-message { color: var(--a2ui-datetimeinput-color-error, red); font-size: var(--a2ui-font-size-xs, 0.75rem); }
a2ui-choicepicker, a2ui-choicepicker .a2ui-choice-picker { display: flex; flex-direction: column; width: 100%; gap: var(--a2ui-choicepicker-gap, var(--a2ui-spacing-xs, 0.25rem)); padding: var(--a2ui-choicepicker-padding, 0); }
a2ui-choicepicker .options, a2ui-choicepicker .a2ui-options-group { display: flex; flex-direction: column; gap: var(--a2ui-choicepicker-gap, var(--a2ui-spacing-xs, 0.25rem)); }
a2ui-choicepicker label, a2ui-choicepicker .a2ui-option-label { display: flex; align-items: center; gap: var(--a2ui-choicepicker-gap, var(--a2ui-spacing-xs, 0.25rem)); cursor: pointer; color: var(--a2ui-text-color-text, var(--a2ui-choicepicker-label-color, inherit)); font-size: var(--a2ui-choicepicker-label-font-size, inherit); }
a2ui-choicepicker, a2ui-choicepicker > label { font-size: var( --a2ui-choicepicker-label-font-size, var(--a2ui-label-font-size, var(--a2ui-font-size-s)) ); font-weight: var(--a2ui-choicepicker-label-font-weight, var(--a2ui-label-font-weight, bold)); }
a2ui-choicepicker .filter-input { background-color: var(--a2ui-color-input, #fff); color: var(--a2ui-color-on-input, #333); border: var( --a2ui-textfield-border, var(--a2ui-border, 1px solid var(--a2ui-color-border, #ccc)) ); border-radius: var(--a2ui-textfield-border-radius, var(--a2ui-spacing-m, 4px)); padding: var( --a2ui-choicepicker-filter-padding, var(--a2ui-spacing-xs, 4px) var(--a2ui-spacing-s, 8px) ); margin-bottom: var(--a2ui-choicepicker-filter-margin-bottom, var(--a2ui-spacing-s, 0.25rem)); font-family: inherit; }
a2ui-choicepicker .filter-input:focus { outline: none; border-color: var(--a2ui-textfield-color-border-focus, var(--a2ui-color-primary, #17e)); }
a2ui-choicepicker .a2ui-option-input { width: var(--a2ui-choicepicker-checkbox-size, 1rem); height: var(--a2ui-choicepicker-checkbox-size, 1rem); }
a2ui-choicepicker .chips, a2ui-choicepicker .a2ui-chips-group { display: flex; flex-direction: row; flex-wrap: wrap; gap: var(--a2ui-choicepicker-gap, var(--a2ui-spacing-xs, 0.25rem)); }
a2ui-choicepicker .chip, a2ui-choicepicker .a2ui-chip { padding: var( --a2ui-choicepicker-chip-padding, var(--a2ui-spacing-s, 4px) var(--a2ui-spacing-m, 8px) ); border-radius: var(--a2ui-choicepicker-chip-border-radius, 999px); border: var(--a2ui-choicepicker-chip-border, 1px solid var(--a2ui-color-border, #ccc)); background-color: var(--a2ui-choicepicker-chip-background, var(--a2ui-color-surface, #fff)); color: var(--a2ui-color-on-surface, inherit); cursor: pointer; font-size: var(--a2ui-choicepicker-chip-font-size, var(--a2ui-font-size-xs, 0.75rem)); font-family: inherit; font-weight: var(--a2ui-choicepicker-chip-font-weight, normal); transition: all 0.2s; }
a2ui-choicepicker .chip.selected, a2ui-choicepicker .chip.active, a2ui-choicepicker .a2ui-chip.selected, a2ui-choicepicker .a2ui-chip.active { background-color: var( --a2ui-choicepicker-chip-background-selected, var(--a2ui-color-primary, #007bff) ); color: var(--a2ui-color-on-primary, #fff); border-color: var( --a2ui-choicepicker-chip-background-selected, var(--a2ui-color-primary, #007bff) ); }
a2ui-choicepicker .error, a2ui-choicepicker .a2ui-error-message { color: var(--a2ui-choicepicker-color-error, red); font-size: var(--a2ui-font-size-xs, 0.75rem); }
a2ui-tabs .a2ui-tabs { display: flex; flex-direction: column; width: 100%; }
a2ui-tabs .a2ui-tab-bar { display: flex; border-bottom: var(--a2ui-tabs-border, 2px solid var(--a2ui-color-border, #eee)); gap: var(--a2ui-spacing-m, 16px); }
a2ui-tabs .a2ui-tab-button { padding: var(--a2ui-spacing-s, 8px) var(--a2ui-spacing-m, 16px); border: none; background: var(--a2ui-tabs-header-background, transparent); cursor: pointer; font-weight: 500; color: var(--a2ui-tabs-header-color, var(--a2ui-text-caption-color, #666)); border-bottom: 2px solid transparent; margin-bottom: -2px; }
a2ui-tabs .a2ui-tab-button.active { background: var(--a2ui-tabs-header-background-active, transparent); color: var(--a2ui-tabs-header-color-active, var(--a2ui-color-primary, #007bff)); border-bottom: 2px solid var(--a2ui-color-primary, #007bff); }
a2ui-tabs .a2ui-tab-content { padding: var(--a2ui-tabs-content-padding, var(--a2ui-spacing-m, 16px) 0); }
a2ui-modal, a2ui-modal { display: inline-block; }
a2ui-modal .a2ui-modal-wrapper { display: inline-block; }
a2ui-modal .a2ui-modal-trigger { cursor: pointer; }
a2ui-modal .a2ui-modal-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: var(--a2ui-modal-backdrop-bg, rgba(0, 0, 0, 0.5)); display: flex; justify-content: center; align-items: center; z-index: 1000; }
a2ui-modal .a2ui-modal-content { background: var(--a2ui-modal-background, var(--a2ui-color-surface, #fff)); padding: var(--a2ui-modal-padding, var(--a2ui-spacing-xl, 32px)); border-radius: var(--a2ui-modal-border-radius, var(--a2ui-border-radius, 8px)); position: relative; min-width: 300px; max-width: 80%; max-height: 80%; overflow-y: auto; box-shadow: var(--a2ui-modal-box-shadow, 0 10px 25px rgba(0, 0, 0, 0.2)); }
a2ui-modal .a2ui-modal-close { position: absolute; top: 10px; right: 15px; border: none; background: none; font-size: 24px; cursor: pointer; color: var(--a2ui-text-caption-color, #999); }
a2ui-modal .a2ui-modal-close:hover { color: var(--a2ui-text-color, #333); }
a2ui-modal dialog.a2ui-modal-overlay { border:0; padding:0; color:inherit; background:transparent; width:100vw; height:100vh; max-width:none; max-height:none; }
a2ui-modal dialog.a2ui-modal-overlay:not([open]) { display:none; }
a2ui-modal dialog.a2ui-modal-overlay::backdrop { background:var(--a2ui-modal-backdrop-bg,rgba(0,0,0,.5)); }
a2ui-modal dialog.a2ui-modal-overlay[open] { display:flex; background:transparent; }
`;
