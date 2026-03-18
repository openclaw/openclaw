//#region src/line/actions.ts
/**
* Create a message action (sends text when tapped)
*/
function messageAction(label, text) {
	return {
		type: "message",
		label: label.slice(0, 20),
		text: text ?? label
	};
}
/**
* Create a URI action (opens a URL when tapped)
*/
function uriAction(label, uri) {
	return {
		type: "uri",
		label: label.slice(0, 20),
		uri
	};
}
/**
* Create a postback action (sends data to webhook when tapped)
*/
function postbackAction(label, data, displayText) {
	return {
		type: "postback",
		label: label.slice(0, 20),
		data: data.slice(0, 300),
		displayText: displayText?.slice(0, 300)
	};
}
/**
* Create a datetime picker action
*/
function datetimePickerAction(label, data, mode, options) {
	return {
		type: "datetimepicker",
		label: label.slice(0, 20),
		data: data.slice(0, 300),
		mode,
		initial: options?.initial,
		max: options?.max,
		min: options?.min
	};
}
//#endregion
//#region src/line/template-messages.ts
function buildTemplatePayloadAction(action) {
	if (action.type === "uri" && action.uri) return uriAction(action.label, action.uri);
	if (action.type === "postback" && action.data) return postbackAction(action.label, action.data, action.label);
	return messageAction(action.label, action.data ?? action.label);
}
/**
* Create a confirm template (yes/no style dialog)
*/
function createConfirmTemplate(text, confirmAction, cancelAction, altText) {
	const template = {
		type: "confirm",
		text: text.slice(0, 240),
		actions: [confirmAction, cancelAction]
	};
	return {
		type: "template",
		altText: altText?.slice(0, 400) ?? text.slice(0, 400),
		template
	};
}
/**
* Create a button template with title, text, and action buttons
*/
function createButtonTemplate(title, text, actions, options) {
	const textLimit = Boolean(options?.thumbnailImageUrl?.trim()) ? 160 : 60;
	const template = {
		type: "buttons",
		title: title.slice(0, 40),
		text: text.slice(0, textLimit),
		actions: actions.slice(0, 4),
		thumbnailImageUrl: options?.thumbnailImageUrl,
		imageAspectRatio: options?.imageAspectRatio ?? "rectangle",
		imageSize: options?.imageSize ?? "cover",
		imageBackgroundColor: options?.imageBackgroundColor,
		defaultAction: options?.defaultAction
	};
	return {
		type: "template",
		altText: options?.altText?.slice(0, 400) ?? `${title}: ${text}`.slice(0, 400),
		template
	};
}
/**
* Create a carousel template with multiple columns
*/
function createTemplateCarousel(columns, options) {
	const template = {
		type: "carousel",
		columns: columns.slice(0, 10),
		imageAspectRatio: options?.imageAspectRatio ?? "rectangle",
		imageSize: options?.imageSize ?? "cover"
	};
	return {
		type: "template",
		altText: options?.altText?.slice(0, 400) ?? "View carousel",
		template
	};
}
/**
* Create a carousel column for use with createTemplateCarousel
*/
function createCarouselColumn(params) {
	return {
		title: params.title?.slice(0, 40),
		text: params.text.slice(0, 120),
		actions: params.actions.slice(0, 3),
		thumbnailImageUrl: params.thumbnailImageUrl,
		imageBackgroundColor: params.imageBackgroundColor,
		defaultAction: params.defaultAction
	};
}
/**
* Create an image carousel template (simpler, image-focused carousel)
*/
function createImageCarousel(columns, altText) {
	const template = {
		type: "image_carousel",
		columns: columns.slice(0, 10)
	};
	return {
		type: "template",
		altText: altText?.slice(0, 400) ?? "View images",
		template
	};
}
/**
* Create an image carousel column for use with createImageCarousel
*/
function createImageCarouselColumn(imageUrl, action) {
	return {
		imageUrl,
		action
	};
}
/**
* Create a simple yes/no confirmation dialog
*/
function createYesNoConfirm(question, options) {
	return createConfirmTemplate(question, options?.yesData ? postbackAction(options.yesText ?? "Yes", options.yesData, options.yesText ?? "Yes") : messageAction(options?.yesText ?? "Yes"), options?.noData ? postbackAction(options.noText ?? "No", options.noData, options.noText ?? "No") : messageAction(options?.noText ?? "No"), options?.altText);
}
/**
* Create a button menu with simple text buttons
*/
function createButtonMenu(title, text, buttons, options) {
	return createButtonTemplate(title, text, buttons.slice(0, 4).map((btn) => messageAction(btn.label, btn.text)), {
		thumbnailImageUrl: options?.thumbnailImageUrl,
		altText: options?.altText
	});
}
/**
* Create a button menu with URL links
*/
function createLinkMenu(title, text, links, options) {
	return createButtonTemplate(title, text, links.slice(0, 4).map((link) => uriAction(link.label, link.url)), {
		thumbnailImageUrl: options?.thumbnailImageUrl,
		altText: options?.altText
	});
}
/**
* Create a simple product/item carousel
*/
function createProductCarousel(products, altText) {
	return createTemplateCarousel(products.slice(0, 10).map((product) => {
		const actions = [];
		if (product.actionUrl) actions.push(uriAction(product.actionLabel ?? "View", product.actionUrl));
		else if (product.actionData) actions.push(postbackAction(product.actionLabel ?? "Select", product.actionData));
		else actions.push(messageAction(product.actionLabel ?? "Select", product.title));
		return createCarouselColumn({
			title: product.title,
			text: product.price ? `${product.description}\n${product.price}`.slice(0, 120) : product.description,
			thumbnailImageUrl: product.imageUrl,
			actions
		});
	}), { altText });
}
/**
* Convert a TemplateMessagePayload from ReplyPayload to a LINE TemplateMessage
*/
function buildTemplateMessageFromPayload(payload) {
	switch (payload.type) {
		case "confirm": {
			const confirmAction = payload.confirmData.startsWith("http") ? uriAction(payload.confirmLabel, payload.confirmData) : payload.confirmData.includes("=") ? postbackAction(payload.confirmLabel, payload.confirmData, payload.confirmLabel) : messageAction(payload.confirmLabel, payload.confirmData);
			const cancelAction = payload.cancelData.startsWith("http") ? uriAction(payload.cancelLabel, payload.cancelData) : payload.cancelData.includes("=") ? postbackAction(payload.cancelLabel, payload.cancelData, payload.cancelLabel) : messageAction(payload.cancelLabel, payload.cancelData);
			return createConfirmTemplate(payload.text, confirmAction, cancelAction, payload.altText);
		}
		case "buttons": {
			const actions = payload.actions.slice(0, 4).map((action) => buildTemplatePayloadAction(action));
			return createButtonTemplate(payload.title, payload.text, actions, {
				thumbnailImageUrl: payload.thumbnailImageUrl,
				altText: payload.altText
			});
		}
		case "carousel": return createTemplateCarousel(payload.columns.slice(0, 10).map((col) => {
			const colActions = col.actions.slice(0, 3).map((action) => buildTemplatePayloadAction(action));
			return createCarouselColumn({
				title: col.title,
				text: col.text,
				thumbnailImageUrl: col.thumbnailImageUrl,
				actions: colActions
			});
		}), { altText: payload.altText });
		default: return null;
	}
}
//#endregion
export { createConfirmTemplate as a, createLinkMenu as c, createYesNoConfirm as d, datetimePickerAction as f, uriAction as h, createCarouselColumn as i, createProductCarousel as l, postbackAction as m, createButtonMenu as n, createImageCarousel as o, messageAction as p, createButtonTemplate as r, createImageCarouselColumn as s, buildTemplateMessageFromPayload as t, createTemplateCarousel as u };
