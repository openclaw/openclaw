"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
var _Webhooks_instances, _Webhooks_validateSecret, _Webhooks_getRequiredHeader;
Object.defineProperty(exports, "__esModule", { value: true });
exports.Webhooks = void 0;
const tslib_1 = require("../../internal/tslib.js");
const error_1 = require("../../error.js");
const resource_1 = require("../../core/resource.js");
const headers_1 = require("../../internal/headers.js");
class Webhooks extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        _Webhooks_instances.add(this);
    }
    /**
     * Validates that the given payload was sent by OpenAI and parses the payload.
     */
    async unwrap(payload, headers, secret = this._client.webhookSecret, tolerance = 300) {
        await this.verifySignature(payload, headers, secret, tolerance);
        return JSON.parse(payload);
    }
    /**
     * Validates whether or not the webhook payload was sent by OpenAI.
     *
     * An error will be raised if the webhook payload was not sent by OpenAI.
     *
     * @param payload - The webhook payload
     * @param headers - The webhook headers
     * @param secret - The webhook secret (optional, will use client secret if not provided)
     * @param tolerance - Maximum age of the webhook in seconds (default: 300 = 5 minutes)
     */
    async verifySignature(payload, headers, secret = this._client.webhookSecret, tolerance = 300) {
        if (typeof crypto === 'undefined' ||
            typeof crypto.subtle.importKey !== 'function' ||
            typeof crypto.subtle.verify !== 'function') {
            throw new Error('Webhook signature verification is only supported when the `crypto` global is defined');
        }
        tslib_1.__classPrivateFieldGet(this, _Webhooks_instances, "m", _Webhooks_validateSecret).call(this, secret);
        const headersObj = (0, headers_1.buildHeaders)([headers]).values;
        const signatureHeader = tslib_1.__classPrivateFieldGet(this, _Webhooks_instances, "m", _Webhooks_getRequiredHeader).call(this, headersObj, 'webhook-signature');
        const timestamp = tslib_1.__classPrivateFieldGet(this, _Webhooks_instances, "m", _Webhooks_getRequiredHeader).call(this, headersObj, 'webhook-timestamp');
        const webhookId = tslib_1.__classPrivateFieldGet(this, _Webhooks_instances, "m", _Webhooks_getRequiredHeader).call(this, headersObj, 'webhook-id');
        // Validate timestamp to prevent replay attacks
        const timestampSeconds = parseInt(timestamp, 10);
        if (isNaN(timestampSeconds)) {
            throw new error_1.InvalidWebhookSignatureError('Invalid webhook timestamp format');
        }
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (nowSeconds - timestampSeconds > tolerance) {
            throw new error_1.InvalidWebhookSignatureError('Webhook timestamp is too old');
        }
        if (timestampSeconds > nowSeconds + tolerance) {
            throw new error_1.InvalidWebhookSignatureError('Webhook timestamp is too new');
        }
        // Extract signatures from v1,<base64> format
        // The signature header can have multiple values, separated by spaces.
        // Each value is in the format v1,<base64>. We should accept if any match.
        const signatures = signatureHeader
            .split(' ')
            .map((part) => (part.startsWith('v1,') ? part.substring(3) : part));
        // Decode the secret if it starts with whsec_
        const decodedSecret = secret.startsWith('whsec_') ?
            Buffer.from(secret.replace('whsec_', ''), 'base64')
            : Buffer.from(secret, 'utf-8');
        // Create the signed payload: {webhook_id}.{timestamp}.{payload}
        const signedPayload = webhookId ? `${webhookId}.${timestamp}.${payload}` : `${timestamp}.${payload}`;
        // Import the secret as a cryptographic key for HMAC
        const key = await crypto.subtle.importKey('raw', decodedSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        // Check if any signature matches using timing-safe WebCrypto verify
        for (const signature of signatures) {
            try {
                const signatureBytes = Buffer.from(signature, 'base64');
                const isValid = await crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(signedPayload));
                if (isValid) {
                    return; // Valid signature found
                }
            }
            catch {
                // Invalid base64 or signature format, continue to next signature
                continue;
            }
        }
        throw new error_1.InvalidWebhookSignatureError('The given webhook signature does not match the expected signature');
    }
}
exports.Webhooks = Webhooks;
_Webhooks_instances = new WeakSet(), _Webhooks_validateSecret = function _Webhooks_validateSecret(secret) {
    if (typeof secret !== 'string' || secret.length === 0) {
        throw new Error(`The webhook secret must either be set using the env var, OPENAI_WEBHOOK_SECRET, on the client class, OpenAI({ webhookSecret: '123' }), or passed to this function`);
    }
}, _Webhooks_getRequiredHeader = function _Webhooks_getRequiredHeader(headers, name) {
    if (!headers) {
        throw new Error(`Headers are required`);
    }
    const value = headers.get(name);
    if (value === null || value === undefined) {
        throw new Error(`Missing required header: ${name}`);
    }
    return value;
};
//# sourceMappingURL=webhooks.js.map