//#region extensions/browser/test-fetch.ts
function withBrowserFetchPreconnect(fn) {
	return Object.assign(fn, {
		preconnect: (_url, _options) => {},
		__openclawAcceptsDispatcher: true
	});
}
//#endregion
export { withBrowserFetchPreconnect };
