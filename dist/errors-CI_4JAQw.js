//#region extensions/browser/src/browser/errors.ts
const BROWSER_ENDPOINT_BLOCKED_MESSAGE = "browser endpoint blocked by policy";
const BROWSER_NAVIGATION_BLOCKED_MESSAGE = "browser navigation blocked by policy";
var BrowserError = class extends Error {
	constructor(message, status = 500, options) {
		super(message, options);
		this.name = new.target.name;
		this.status = status;
	}
};
/**
* Raised when a browser CDP endpoint (the cdpUrl itself) fails the
* configured SSRF policy. Distinct from a blocked navigation target so
* callers see "fix your browser endpoint config" rather than "fix your
* navigation URL".
*/
var BrowserCdpEndpointBlockedError = class extends BrowserError {
	constructor(options) {
		super(BROWSER_ENDPOINT_BLOCKED_MESSAGE, 400, options);
	}
};
var BrowserValidationError = class extends BrowserError {
	constructor(message, options) {
		super(message, 400, options);
	}
};
var BrowserTargetAmbiguousError = class extends BrowserError {
	constructor(message = "ambiguous target id prefix", options) {
		super(message, 409, options);
	}
};
var BrowserTabNotFoundError = class extends BrowserError {
	constructor(inputOrMessage, options) {
		const input = typeof inputOrMessage === "object" ? inputOrMessage.input?.trim() : inputOrMessage?.trim();
		const message = input ? /^\d+$/.test(input) ? `tab not found: browser tab "${input}" not found. Numeric values are not tab targets; use a stable tab id like "t1", a label, or a raw targetId. For positional selection, use "openclaw browser tab select ${input}".` : `tab not found: browser tab "${input}" not found. Use action=tabs and pass suggestedTargetId, tabId, label, or raw targetId.` : "tab not found";
		super(message, 404, options);
	}
};
var BrowserProfileNotFoundError = class extends BrowserError {
	constructor(message, options) {
		super(message, 404, options);
	}
};
var BrowserConflictError = class extends BrowserError {
	constructor(message, options) {
		super(message, 409, options);
	}
};
var BrowserResetUnsupportedError = class extends BrowserError {
	constructor(message, options) {
		super(message, 400, options);
	}
};
var BrowserProfileUnavailableError = class extends BrowserError {
	constructor(message, options) {
		super(message, 409, options);
	}
};
var BrowserResourceExhaustedError = class extends BrowserError {
	constructor(message, options) {
		super(message, 507, options);
	}
};
function toBrowserErrorResponse(err) {
	if (err instanceof BrowserError) return {
		status: err.status,
		message: err.message
	};
	if (err instanceof Error && err.name === "BlockedBrowserTargetError") return {
		status: 409,
		message: err.message
	};
	if (err instanceof Error && err.name === "SsrFBlockedError") return {
		status: 400,
		message: BROWSER_NAVIGATION_BLOCKED_MESSAGE
	};
	if (err instanceof Error && err.name === "InvalidBrowserNavigationUrlError") return {
		status: 400,
		message: err.message
	};
	return null;
}
//#endregion
export { BrowserProfileUnavailableError as a, BrowserTabNotFoundError as c, toBrowserErrorResponse as d, BrowserProfileNotFoundError as i, BrowserTargetAmbiguousError as l, BrowserConflictError as n, BrowserResetUnsupportedError as o, BrowserError as r, BrowserResourceExhaustedError as s, BrowserCdpEndpointBlockedError as t, BrowserValidationError as u };
