import { t as __exportAll } from "./rolldown-runtime-C3SqQTfK.js";
import { A as Button, B as Separator, D as Modal, E as Label, F as MediaGallery, H as TextDisplay, I as MentionableSelectMenu, K as parseCustomId, L as RoleSelectMenu, M as Container, N as File, O as RadioGroup, P as LinkButton, R as Row, T as CheckboxGroup, U as Thumbnail, V as StringSelectMenu, W as UserSelectMenu, j as ChannelSelectMenu, k as TextInput, z as Section } from "./discord-eZlimVfW.js";
import { t as buildDiscordInteractiveComponents } from "./shared-interactive-KgJjCqnB.js";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { ButtonStyle, MessageFlags, TextInputStyle } from "discord-api-types/v10";
import crypto from "node:crypto";
//#region extensions/discord/src/component-custom-id.ts
const DISCORD_COMPONENT_CUSTOM_ID_KEY = "occomp";
const DISCORD_MODAL_CUSTOM_ID_KEY = "ocmodal";
function buildDiscordComponentCustomId(params) {
	const base = `${DISCORD_COMPONENT_CUSTOM_ID_KEY}:cid=${params.componentId}`;
	return params.modalId ? `${base};mid=${params.modalId}` : base;
}
function buildDiscordModalCustomId(modalId) {
	return `${DISCORD_MODAL_CUSTOM_ID_KEY}:mid=${modalId}`;
}
function parseDiscordComponentCustomId(id) {
	const parsed = parseCustomId(id);
	if (parsed.key !== "occomp") return null;
	const componentId = parsed.data.cid;
	if (typeof componentId !== "string" || !componentId.trim()) return null;
	const modalId = parsed.data.mid;
	return {
		componentId,
		modalId: typeof modalId === "string" && modalId.trim() ? modalId : void 0
	};
}
function parseDiscordModalCustomId(id) {
	const parsed = parseCustomId(id);
	if (parsed.key !== "ocmodal") return null;
	const modalId = parsed.data.mid;
	if (typeof modalId !== "string" || !modalId.trim()) return null;
	return modalId;
}
function isDiscordComponentWildcardRegistrationId(id) {
	return /^__openclaw_discord_component_[a-z_]+_wildcard__$/.test(id);
}
function parseDiscordComponentCustomIdForInteraction(id) {
	if (id === "*" || isDiscordComponentWildcardRegistrationId(id)) return {
		key: "*",
		data: {}
	};
	const parsed = parseCustomId(id);
	if (parsed.key !== "occomp") return parsed;
	return {
		key: "*",
		data: parsed.data
	};
}
function parseDiscordModalCustomIdForInteraction(id) {
	if (id === "*" || isDiscordComponentWildcardRegistrationId(id)) return {
		key: "*",
		data: {}
	};
	const parsed = parseCustomId(id);
	if (parsed.key !== "ocmodal") return parsed;
	return {
		key: "*",
		data: parsed.data
	};
}
//#endregion
//#region extensions/discord/src/components.parse.ts
const DISCORD_COMPONENT_ATTACHMENT_PREFIX = "attachment://";
const BLOCK_ALIASES = new Map([["row", "actions"], ["action-row", "actions"]]);
function requireObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value;
}
function readString(value, label, opts) {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const trimmed = value.trim();
	if (!opts?.allowEmpty && !trimmed) throw new Error(`${label} cannot be empty`);
	return opts?.allowEmpty ? value : trimmed;
}
function readOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function readOptionalStringArray(value, label) {
	if (value === void 0) return;
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	if (value.length === 0) return;
	return value.map((entry, index) => readString(entry, `${label}[${index}]`));
}
function readOptionalNumber(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return value;
}
function readOptionalEmoji(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const obj = value;
	return {
		name: readString(obj.name, `${label}.name`),
		id: readOptionalString(obj.id),
		animated: typeof obj.animated === "boolean" ? obj.animated : void 0
	};
}
function normalizeModalFieldName(value, index) {
	const trimmed = value?.trim();
	if (trimmed) return trimmed;
	return `field_${index + 1}`;
}
function normalizeAttachmentRef(value, label) {
	const trimmed = value.trim();
	if (!trimmed.startsWith("attachment://")) throw new Error(`${label} must start with "${DISCORD_COMPONENT_ATTACHMENT_PREFIX}"`);
	const attachmentName = trimmed.slice(13).trim();
	if (!attachmentName) throw new Error(`${label} must include an attachment filename`);
	return `${DISCORD_COMPONENT_ATTACHMENT_PREFIX}${attachmentName}`;
}
function resolveDiscordComponentAttachmentName(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith("attachment://")) throw new Error(`Attachment reference must start with "${DISCORD_COMPONENT_ATTACHMENT_PREFIX}"`);
	const attachmentName = trimmed.slice(13).trim();
	if (!attachmentName) throw new Error("Attachment reference must include a filename");
	return attachmentName;
}
function mapButtonStyle(style) {
	switch (normalizeLowercaseStringOrEmpty(style ?? "primary")) {
		case "secondary": return ButtonStyle.Secondary;
		case "success": return ButtonStyle.Success;
		case "danger": return ButtonStyle.Danger;
		case "link": return ButtonStyle.Link;
		default: return ButtonStyle.Primary;
	}
}
function mapTextInputStyle(style) {
	return style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short;
}
function normalizeBlockType(raw) {
	const lowered = normalizeLowercaseStringOrEmpty(raw);
	return BLOCK_ALIASES.get(lowered) ?? lowered;
}
function parseSelectOptions(raw, label) {
	if (raw === void 0) return;
	if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
	return raw.map((entry, index) => {
		const obj = requireObject(entry, `${label}[${index}]`);
		return {
			label: readString(obj.label, `${label}[${index}].label`),
			value: readString(obj.value, `${label}[${index}].value`),
			description: readOptionalString(obj.description),
			emoji: readOptionalEmoji(obj.emoji, `${label}[${index}].emoji`),
			default: typeof obj.default === "boolean" ? obj.default : void 0
		};
	});
}
function parseButtonSpec(raw, label) {
	const obj = requireObject(raw, label);
	const style = readOptionalString(obj.style);
	const url = readOptionalString(obj.url);
	if ((style === "link" || url) && !url) throw new Error(`${label}.url is required for link buttons`);
	return {
		label: readString(obj.label, `${label}.label`),
		style,
		url,
		callbackData: readOptionalString(obj.callbackData),
		emoji: readOptionalEmoji(obj.emoji, `${label}.emoji`),
		disabled: typeof obj.disabled === "boolean" ? obj.disabled : void 0,
		allowedUsers: readOptionalStringArray(obj.allowedUsers, `${label}.allowedUsers`)
	};
}
function parseSelectSpec(raw, label) {
	const obj = requireObject(raw, label);
	const type = readOptionalString(obj.type);
	const allowedTypes = [
		"string",
		"user",
		"role",
		"mentionable",
		"channel"
	];
	if (type && !allowedTypes.includes(type)) throw new Error(`${label}.type must be one of ${allowedTypes.join(", ")}`);
	return {
		type,
		callbackData: readOptionalString(obj.callbackData),
		placeholder: readOptionalString(obj.placeholder),
		minValues: readOptionalNumber(obj.minValues),
		maxValues: readOptionalNumber(obj.maxValues),
		options: parseSelectOptions(obj.options, `${label}.options`),
		allowedUsers: readOptionalStringArray(obj.allowedUsers, `${label}.allowedUsers`)
	};
}
function parseModalField(raw, label, index) {
	const obj = requireObject(raw, label);
	const type = normalizeLowercaseStringOrEmpty(readString(obj.type, `${label}.type`));
	const supported = [
		"text",
		"checkbox",
		"radio",
		"select",
		"role-select",
		"user-select"
	];
	if (!supported.includes(type)) throw new Error(`${label}.type must be one of ${supported.join(", ")}`);
	const options = parseSelectOptions(obj.options, `${label}.options`);
	if ([
		"checkbox",
		"radio",
		"select"
	].includes(type) && (!options || options.length === 0)) throw new Error(`${label}.options is required for ${type} fields`);
	return {
		type,
		name: normalizeModalFieldName(readOptionalString(obj.name), index),
		label: readString(obj.label, `${label}.label`),
		description: readOptionalString(obj.description),
		placeholder: readOptionalString(obj.placeholder),
		required: typeof obj.required === "boolean" ? obj.required : void 0,
		options,
		minValues: readOptionalNumber(obj.minValues),
		maxValues: readOptionalNumber(obj.maxValues),
		minLength: readOptionalNumber(obj.minLength),
		maxLength: readOptionalNumber(obj.maxLength),
		style: readOptionalString(obj.style)
	};
}
function parseComponentBlock(raw, label) {
	const obj = requireObject(raw, label);
	switch (normalizeBlockType(normalizeLowercaseStringOrEmpty(readString(obj.type, `${label}.type`)))) {
		case "text": return {
			type: "text",
			text: readString(obj.text, `${label}.text`)
		};
		case "section": {
			const text = readOptionalString(obj.text);
			const textsRaw = obj.texts;
			const texts = Array.isArray(textsRaw) ? textsRaw.map((entry, idx) => readString(entry, `${label}.texts[${idx}]`)) : void 0;
			if (!text && (!texts || texts.length === 0)) throw new Error(`${label}.text or ${label}.texts is required for section blocks`);
			let accessory;
			if (obj.accessory !== void 0) {
				const accessoryObj = requireObject(obj.accessory, `${label}.accessory`);
				const accessoryType = normalizeLowercaseStringOrEmpty(readString(accessoryObj.type, `${label}.accessory.type`));
				if (accessoryType === "thumbnail") accessory = {
					type: "thumbnail",
					url: readString(accessoryObj.url, `${label}.accessory.url`)
				};
				else if (accessoryType === "button") accessory = {
					type: "button",
					button: parseButtonSpec(accessoryObj.button, `${label}.accessory.button`)
				};
				else throw new Error(`${label}.accessory.type must be "thumbnail" or "button"`);
			}
			return {
				type: "section",
				text,
				texts,
				accessory
			};
		}
		case "separator": {
			const spacingRaw = obj.spacing;
			let spacing;
			if (spacingRaw === "small" || spacingRaw === "large") spacing = spacingRaw;
			else if (spacingRaw === 1 || spacingRaw === 2) spacing = spacingRaw;
			else if (spacingRaw !== void 0) throw new Error(`${label}.spacing must be "small", "large", 1, or 2`);
			const divider = typeof obj.divider === "boolean" ? obj.divider : void 0;
			return {
				type: "separator",
				spacing,
				divider
			};
		}
		case "actions": {
			const buttonsRaw = obj.buttons;
			const buttons = Array.isArray(buttonsRaw) ? buttonsRaw.map((entry, idx) => parseButtonSpec(entry, `${label}.buttons[${idx}]`)) : void 0;
			const select = obj.select ? parseSelectSpec(obj.select, `${label}.select`) : void 0;
			if ((!buttons || buttons.length === 0) && !select) throw new Error(`${label} requires buttons or select`);
			if (buttons && select) throw new Error(`${label} cannot include both buttons and select`);
			return {
				type: "actions",
				buttons,
				select
			};
		}
		case "media-gallery": {
			const itemsRaw = obj.items;
			if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) throw new Error(`${label}.items must be a non-empty array`);
			return {
				type: "media-gallery",
				items: itemsRaw.map((entry, idx) => {
					const itemObj = requireObject(entry, `${label}.items[${idx}]`);
					return {
						url: readString(itemObj.url, `${label}.items[${idx}].url`),
						description: readOptionalString(itemObj.description),
						spoiler: typeof itemObj.spoiler === "boolean" ? itemObj.spoiler : void 0
					};
				})
			};
		}
		case "file": return {
			type: "file",
			file: normalizeAttachmentRef(readString(obj.file, `${label}.file`), `${label}.file`),
			spoiler: typeof obj.spoiler === "boolean" ? obj.spoiler : void 0
		};
		default: throw new Error(`${label}.type must be a supported component block`);
	}
}
function readDiscordComponentSpec(raw) {
	if (raw === void 0 || raw === null) return null;
	const obj = requireObject(raw, "components");
	const blocksRaw = obj.blocks;
	const blocks = Array.isArray(blocksRaw) ? blocksRaw.map((entry, idx) => parseComponentBlock(entry, `components.blocks[${idx}]`)) : void 0;
	const modalRaw = obj.modal;
	const reusable = typeof obj.reusable === "boolean" ? obj.reusable : void 0;
	let modal;
	if (modalRaw !== void 0) {
		const modalObj = requireObject(modalRaw, "components.modal");
		const fieldsRaw = modalObj.fields;
		if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) throw new Error("components.modal.fields must be a non-empty array");
		if (fieldsRaw.length > 5) throw new Error("components.modal.fields supports up to 5 inputs");
		const fields = fieldsRaw.map((entry, idx) => parseModalField(entry, `components.modal.fields[${idx}]`, idx));
		modal = {
			title: readString(modalObj.title, "components.modal.title"),
			callbackData: readOptionalString(modalObj.callbackData),
			triggerLabel: readOptionalString(modalObj.triggerLabel),
			triggerStyle: readOptionalString(modalObj.triggerStyle),
			allowedUsers: readOptionalStringArray(modalObj.allowedUsers, "components.modal.allowedUsers"),
			fields
		};
	}
	return {
		text: readOptionalString(obj.text),
		reusable,
		container: typeof obj.container === "object" && obj.container && !Array.isArray(obj.container) ? {
			accentColor: obj.container.accentColor,
			spoiler: typeof obj.container.spoiler === "boolean" ? obj.container.spoiler : void 0
		} : void 0,
		blocks,
		modal
	};
}
//#endregion
//#region extensions/discord/src/components.builders.ts
function createShortId(prefix) {
	return `${prefix}${crypto.randomBytes(6).toString("base64url")}`;
}
function buildTextDisplays(text, texts) {
	if (texts && texts.length > 0) return texts.map((entry) => new TextDisplay(entry));
	if (text) return [new TextDisplay(text)];
	return [];
}
function createButtonComponent(params) {
	const style = mapButtonStyle(params.spec.style);
	if (style === ButtonStyle.Link || Boolean(params.spec.url)) {
		if (!params.spec.url) throw new Error("Link buttons require a url");
		const linkUrl = params.spec.url;
		class DynamicLinkButton extends LinkButton {
			constructor(..._args) {
				super(..._args);
				this.label = params.spec.label;
				this.url = linkUrl;
			}
		}
		return { component: new DynamicLinkButton() };
	}
	const componentId = params.componentId ?? createShortId("btn_");
	const internalCustomId = typeof params.spec.internalCustomId === "string" && params.spec.internalCustomId.trim() ? params.spec.internalCustomId.trim() : void 0;
	const customId = internalCustomId ?? buildDiscordComponentCustomId({
		componentId,
		modalId: params.modalId
	});
	class DynamicButton extends Button {
		constructor(..._args2) {
			super(..._args2);
			this.label = params.spec.label;
			this.customId = customId;
			this.style = style;
			this.emoji = params.spec.emoji;
			this.disabled = params.spec.disabled ?? false;
		}
	}
	if (internalCustomId) return { component: new DynamicButton() };
	return {
		component: new DynamicButton(),
		entry: {
			id: componentId,
			kind: params.modalId ? "modal-trigger" : "button",
			label: params.spec.label,
			callbackData: params.spec.callbackData,
			modalId: params.modalId,
			allowedUsers: params.spec.allowedUsers
		}
	};
}
function createSelectComponent(params) {
	const type = normalizeLowercaseStringOrEmpty(params.spec.type ?? "string");
	const componentId = params.componentId ?? createShortId("sel_");
	const customId = buildDiscordComponentCustomId({ componentId });
	const createEntry = (selectType, label, options) => ({
		id: componentId,
		kind: "select",
		label,
		callbackData: params.spec.callbackData,
		selectType,
		...options ? { options } : {},
		allowedUsers: params.spec.allowedUsers
	});
	if (type === "string") {
		const options = params.spec.options ?? [];
		if (options.length === 0) throw new Error("String select menus require options");
		class DynamicStringSelect extends StringSelectMenu {
			constructor(..._args3) {
				super(..._args3);
				this.customId = customId;
				this.options = options;
				this.minValues = params.spec.minValues;
				this.maxValues = params.spec.maxValues;
				this.placeholder = params.spec.placeholder;
				this.disabled = false;
			}
		}
		return {
			component: new DynamicStringSelect(),
			entry: createEntry("string", params.spec.placeholder ?? "select", options.map((option) => ({
				value: option.value,
				label: option.label
			})))
		};
	}
	if (type === "user") {
		class DynamicUserSelect extends UserSelectMenu {
			constructor(..._args4) {
				super(..._args4);
				this.customId = customId;
				this.minValues = params.spec.minValues;
				this.maxValues = params.spec.maxValues;
				this.placeholder = params.spec.placeholder;
				this.disabled = false;
			}
		}
		return {
			component: new DynamicUserSelect(),
			entry: createEntry("user", params.spec.placeholder ?? "user select")
		};
	}
	if (type === "role") {
		class DynamicRoleSelect extends RoleSelectMenu {
			constructor(..._args5) {
				super(..._args5);
				this.customId = customId;
				this.minValues = params.spec.minValues;
				this.maxValues = params.spec.maxValues;
				this.placeholder = params.spec.placeholder;
				this.disabled = false;
			}
		}
		return {
			component: new DynamicRoleSelect(),
			entry: createEntry("role", params.spec.placeholder ?? "role select")
		};
	}
	if (type === "mentionable") {
		class DynamicMentionableSelect extends MentionableSelectMenu {
			constructor(..._args6) {
				super(..._args6);
				this.customId = customId;
				this.minValues = params.spec.minValues;
				this.maxValues = params.spec.maxValues;
				this.placeholder = params.spec.placeholder;
				this.disabled = false;
			}
		}
		return {
			component: new DynamicMentionableSelect(),
			entry: createEntry("mentionable", params.spec.placeholder ?? "mentionable select")
		};
	}
	class DynamicChannelSelect extends ChannelSelectMenu {
		constructor(..._args7) {
			super(..._args7);
			this.customId = customId;
			this.minValues = params.spec.minValues;
			this.maxValues = params.spec.maxValues;
			this.placeholder = params.spec.placeholder;
			this.disabled = false;
		}
	}
	return {
		component: new DynamicChannelSelect(),
		entry: createEntry("channel", params.spec.placeholder ?? "channel select")
	};
}
function isSelectComponent(component) {
	return component instanceof StringSelectMenu || component instanceof UserSelectMenu || component instanceof RoleSelectMenu || component instanceof MentionableSelectMenu || component instanceof ChannelSelectMenu;
}
function buildDiscordComponentMessage(params) {
	const entries = [];
	const consumptionGroupId = createShortId("grp_");
	const modals = [];
	const components = [];
	const containerChildren = [];
	const addEntry = (entry) => {
		entries.push({
			...entry,
			sessionKey: params.sessionKey,
			agentId: params.agentId,
			accountId: params.accountId,
			reusable: entry.reusable ?? params.spec.reusable,
			consumptionGroupId
		});
	};
	const text = params.spec.text ?? params.fallbackText;
	if (text) containerChildren.push(new TextDisplay(text));
	for (const block of params.spec.blocks ?? []) {
		if (block.type === "text") {
			containerChildren.push(new TextDisplay(block.text));
			continue;
		}
		if (block.type === "section") {
			const displays = buildTextDisplays(block.text, block.texts);
			if (displays.length > 3) throw new Error("Section blocks support up to 3 text displays");
			let accessory;
			if (block.accessory?.type === "thumbnail") accessory = new Thumbnail(block.accessory.url);
			else if (block.accessory?.type === "button") {
				const { component, entry } = createButtonComponent({ spec: block.accessory.button });
				accessory = component;
				if (entry) addEntry(entry);
			}
			containerChildren.push(new Section(displays, accessory));
			continue;
		}
		if (block.type === "separator") {
			containerChildren.push(new Separator({
				spacing: block.spacing,
				divider: block.divider
			}));
			continue;
		}
		if (block.type === "media-gallery") {
			containerChildren.push(new MediaGallery(block.items));
			continue;
		}
		if (block.type === "file") {
			containerChildren.push(new File(block.file, block.spoiler));
			continue;
		}
		if (block.type === "actions") {
			const rowComponents = [];
			if (block.buttons) {
				if (block.buttons.length > 5) throw new Error("Action rows support up to 5 buttons");
				for (const button of block.buttons) {
					const { component, entry } = createButtonComponent({ spec: button });
					rowComponents.push(component);
					if (entry) addEntry(entry);
				}
			} else if (block.select) {
				const { component, entry } = createSelectComponent({ spec: block.select });
				rowComponents.push(component);
				addEntry(entry);
			}
			containerChildren.push(new Row(rowComponents));
		}
	}
	if (params.spec.modal) {
		const modalId = createShortId("mdl_");
		const fields = params.spec.modal.fields.map((field, index) => ({
			id: createShortId("fld_"),
			name: normalizeModalFieldName(field.name, index),
			label: field.label,
			type: field.type,
			description: field.description,
			placeholder: field.placeholder,
			required: field.required,
			options: field.options,
			minValues: field.minValues,
			maxValues: field.maxValues,
			minLength: field.minLength,
			maxLength: field.maxLength,
			style: field.style
		}));
		modals.push({
			id: modalId,
			title: params.spec.modal.title,
			callbackData: params.spec.modal.callbackData,
			fields,
			sessionKey: params.sessionKey,
			agentId: params.agentId,
			accountId: params.accountId,
			reusable: params.spec.reusable,
			allowedUsers: params.spec.modal.allowedUsers
		});
		const { component, entry } = createButtonComponent({
			spec: {
				label: params.spec.modal.triggerLabel ?? "Open form",
				style: params.spec.modal.triggerStyle ?? "primary",
				allowedUsers: params.spec.modal.allowedUsers
			},
			modalId
		});
		if (entry) addEntry(entry);
		const lastChild = containerChildren.at(-1);
		if (lastChild instanceof Row) {
			const row = lastChild;
			const hasSelect = row.components.some((entry) => isSelectComponent(entry));
			if (row.components.length < 5 && !hasSelect) row.addComponent(component);
			else containerChildren.push(new Row([component]));
		} else containerChildren.push(new Row([component]));
	}
	if (containerChildren.length === 0) throw new Error("components must include at least one block, text, or modal trigger");
	const container = new Container(containerChildren, params.spec.container);
	components.push(container);
	const consumptionGroupEntryIds = entries.map((entry) => entry.id);
	for (const entry of entries) entry.consumptionGroupEntryIds = consumptionGroupEntryIds;
	return {
		components,
		entries,
		modals
	};
}
function buildDiscordComponentMessageFlags(components) {
	return components.some((component) => component.isV2) ? MessageFlags.IsComponentsV2 : void 0;
}
//#endregion
//#region extensions/discord/src/components.modal.ts
const ModalBase = Modal ?? function ModalFallback() {};
function createModalFieldComponent(field) {
	if (field.type === "text") {
		class DynamicTextInput extends TextInput {
			constructor(..._args) {
				super(..._args);
				this.customId = field.id;
				this.style = mapTextInputStyle(field.style);
				this.placeholder = field.placeholder;
				this.required = field.required;
				this.minLength = field.minLength;
				this.maxLength = field.maxLength;
			}
		}
		return new DynamicTextInput();
	}
	if (field.type === "select") {
		const options = field.options ?? [];
		class DynamicModalSelect extends StringSelectMenu {
			constructor(..._args2) {
				super(..._args2);
				this.customId = field.id;
				this.options = options;
				this.required = field.required;
				this.minValues = field.minValues;
				this.maxValues = field.maxValues;
				this.placeholder = field.placeholder;
			}
		}
		return new DynamicModalSelect();
	}
	if (field.type === "role-select") {
		class DynamicModalRoleSelect extends RoleSelectMenu {
			constructor(..._args3) {
				super(..._args3);
				this.customId = field.id;
				this.required = field.required;
				this.minValues = field.minValues;
				this.maxValues = field.maxValues;
				this.placeholder = field.placeholder;
			}
		}
		return new DynamicModalRoleSelect();
	}
	if (field.type === "user-select") {
		class DynamicModalUserSelect extends UserSelectMenu {
			constructor(..._args4) {
				super(..._args4);
				this.customId = field.id;
				this.required = field.required;
				this.minValues = field.minValues;
				this.maxValues = field.maxValues;
				this.placeholder = field.placeholder;
			}
		}
		return new DynamicModalUserSelect();
	}
	if (field.type === "checkbox") {
		const options = field.options ?? [];
		class DynamicCheckboxGroup extends CheckboxGroup {
			constructor(..._args5) {
				super(..._args5);
				this.customId = field.id;
				this.options = options;
				this.required = field.required;
				this.minValues = field.minValues;
				this.maxValues = field.maxValues;
			}
		}
		return new DynamicCheckboxGroup();
	}
	const options = field.options ?? [];
	class DynamicRadioGroup extends RadioGroup {
		constructor(..._args6) {
			super(..._args6);
			this.customId = field.id;
			this.options = options;
			this.required = field.required;
			this.minValues = field.minValues;
			this.maxValues = field.maxValues;
		}
	}
	return new DynamicRadioGroup();
}
var DiscordFormModal = class extends ModalBase {
	constructor(params) {
		super();
		this.customIdParser = parseDiscordModalCustomIdForInteraction;
		this.title = params.title;
		this.customId = buildDiscordModalCustomId(params.modalId);
		this.components = params.fields.map((field) => {
			const component = createModalFieldComponent(field);
			class DynamicLabel extends Label {
				constructor(..._args7) {
					super(..._args7);
					this.label = field.label;
					this.description = field.description;
					this.component = component;
					this.customId = field.id;
				}
			}
			return new DynamicLabel(component);
		});
	}
	async run() {
		throw new Error("Modal handler is not registered for dynamic forms");
	}
};
function createDiscordFormModal(entry) {
	return new DiscordFormModal({
		modalId: entry.id,
		title: entry.title,
		fields: entry.fields
	});
}
//#endregion
//#region extensions/discord/src/components.ts
var components_exports = /* @__PURE__ */ __exportAll({
	DISCORD_COMPONENT_ATTACHMENT_PREFIX: () => DISCORD_COMPONENT_ATTACHMENT_PREFIX,
	DISCORD_COMPONENT_CUSTOM_ID_KEY: () => DISCORD_COMPONENT_CUSTOM_ID_KEY,
	DISCORD_MODAL_CUSTOM_ID_KEY: () => DISCORD_MODAL_CUSTOM_ID_KEY,
	DiscordFormModal: () => DiscordFormModal,
	Modal: () => Modal,
	buildDiscordComponentCustomId: () => buildDiscordComponentCustomId,
	buildDiscordComponentMessage: () => buildDiscordComponentMessage,
	buildDiscordComponentMessageFlags: () => buildDiscordComponentMessageFlags,
	buildDiscordInteractiveComponents: () => buildDiscordInteractiveComponents,
	buildDiscordModalCustomId: () => buildDiscordModalCustomId,
	createDiscordFormModal: () => createDiscordFormModal,
	formatDiscordComponentEventText: () => formatDiscordComponentEventText,
	parseDiscordComponentCustomId: () => parseDiscordComponentCustomId,
	parseDiscordComponentCustomIdForInteraction: () => parseDiscordComponentCustomIdForInteraction,
	parseDiscordModalCustomId: () => parseDiscordModalCustomId,
	parseDiscordModalCustomIdForInteraction: () => parseDiscordModalCustomIdForInteraction,
	readDiscordComponentSpec: () => readDiscordComponentSpec,
	resolveDiscordComponentAttachmentName: () => resolveDiscordComponentAttachmentName
});
function formatDiscordComponentEventText(params) {
	if (params.kind === "button") return `Clicked "${params.label}".`;
	const values = params.values ?? [];
	if (values.length === 0) return `Updated "${params.label}".`;
	return `Selected ${values.join(", ")} from "${params.label}".`;
}
//#endregion
export { parseDiscordModalCustomIdForInteraction as _, buildDiscordComponentMessage as a, readDiscordComponentSpec as c, DISCORD_MODAL_CUSTOM_ID_KEY as d, buildDiscordComponentCustomId as f, parseDiscordModalCustomId as g, parseDiscordComponentCustomIdForInteraction as h, createDiscordFormModal as i, resolveDiscordComponentAttachmentName as l, parseDiscordComponentCustomId as m, formatDiscordComponentEventText as n, buildDiscordComponentMessageFlags as o, buildDiscordModalCustomId as p, DiscordFormModal as r, DISCORD_COMPONENT_ATTACHMENT_PREFIX as s, components_exports as t, DISCORD_COMPONENT_CUSTOM_ID_KEY as u };
