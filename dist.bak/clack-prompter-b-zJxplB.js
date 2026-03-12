import { Ot as theme, h as stripAnsi } from "./entry.js";
import { t as createCliProgress } from "./progress-bvyZjsUc.js";
import { n as stylePromptMessage, r as stylePromptTitle, t as stylePromptHint } from "./prompt-style-wsroINzm.js";
import { t as note$1 } from "./note-DQ26Rw8p.js";
import { t as WizardCancelledError } from "./prompts-CfOu9uZi.js";
import { autocompleteMultiselect, cancel, confirm, intro, isCancel, multiselect, outro, select, spinner, text } from "@clack/prompts";

//#region src/wizard/clack-prompter.ts
function guardCancel(value) {
	if (isCancel(value)) {
		cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
		throw new WizardCancelledError();
	}
	return value;
}
function normalizeSearchTokens(search) {
	return search.toLowerCase().split(/\s+/).map((token) => token.trim()).filter((token) => token.length > 0);
}
function buildOptionSearchText(option) {
	return `${stripAnsi(option.label ?? "")} ${stripAnsi(option.hint ?? "")} ${String(option.value ?? "")}`.toLowerCase();
}
function tokenizedOptionFilter(search, option) {
	const tokens = normalizeSearchTokens(search);
	if (tokens.length === 0) return true;
	const haystack = buildOptionSearchText(option);
	return tokens.every((token) => haystack.includes(token));
}
function createClackPrompter() {
	return {
		intro: async (title) => {
			intro(stylePromptTitle(title) ?? title);
		},
		outro: async (message) => {
			outro(stylePromptTitle(message) ?? message);
		},
		note: async (message, title) => {
			note$1(message, title);
		},
		select: async (params) => guardCancel(await select({
			message: stylePromptMessage(params.message),
			options: params.options.map((opt) => {
				const base = {
					value: opt.value,
					label: opt.label
				};
				return opt.hint === void 0 ? base : {
					...base,
					hint: stylePromptHint(opt.hint)
				};
			}),
			initialValue: params.initialValue
		})),
		multiselect: async (params) => {
			const options = params.options.map((opt) => {
				const base = {
					value: opt.value,
					label: opt.label
				};
				return opt.hint === void 0 ? base : {
					...base,
					hint: stylePromptHint(opt.hint)
				};
			});
			if (params.searchable) return guardCancel(await autocompleteMultiselect({
				message: stylePromptMessage(params.message),
				options,
				initialValues: params.initialValues,
				filter: tokenizedOptionFilter
			}));
			return guardCancel(await multiselect({
				message: stylePromptMessage(params.message),
				options,
				initialValues: params.initialValues
			}));
		},
		text: async (params) => {
			const validate = params.validate;
			return guardCancel(await text({
				message: stylePromptMessage(params.message),
				initialValue: params.initialValue,
				placeholder: params.placeholder,
				validate: validate ? (value) => validate(value ?? "") : void 0
			}));
		},
		confirm: async (params) => guardCancel(await confirm({
			message: stylePromptMessage(params.message),
			initialValue: params.initialValue
		})),
		progress: (label) => {
			const spin = spinner();
			spin.start(theme.accent(label));
			const osc = createCliProgress({
				label,
				indeterminate: true,
				enabled: true,
				fallback: "none"
			});
			return {
				update: (message) => {
					spin.message(theme.accent(message));
					osc.setLabel(message);
				},
				stop: (message) => {
					osc.done();
					spin.stop(message);
				}
			};
		}
	};
}

//#endregion
export { createClackPrompter as t };