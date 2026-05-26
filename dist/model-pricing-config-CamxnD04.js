//#region src/gateway/model-pricing-config.ts
function isGatewayModelPricingEnabled(config) {
	return config.models?.pricing?.enabled !== false;
}
//#endregion
export { isGatewayModelPricingEnabled as t };
