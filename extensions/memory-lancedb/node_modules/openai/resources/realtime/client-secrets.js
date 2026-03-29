"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientSecrets = void 0;
const resource_1 = require("../../core/resource.js");
class ClientSecrets extends resource_1.APIResource {
    /**
     * Create a Realtime client secret with an associated session configuration.
     *
     * Client secrets are short-lived tokens that can be passed to a client app, such
     * as a web frontend or mobile client, which grants access to the Realtime API
     * without leaking your main API key. You can configure a custom TTL for each
     * client secret.
     *
     * You can also attach session configuration options to the client secret, which
     * will be applied to any sessions created using that client secret, but these can
     * also be overridden by the client connection.
     *
     * [Learn more about authentication with client secrets over WebRTC](https://platform.openai.com/docs/guides/realtime-webrtc).
     *
     * Returns the created client secret and the effective session object. The client
     * secret is a string that looks like `ek_1234`.
     *
     * @example
     * ```ts
     * const clientSecret =
     *   await client.realtime.clientSecrets.create();
     * ```
     */
    create(body, options) {
        return this._client.post('/realtime/client_secrets', { body, ...options });
    }
}
exports.ClientSecrets = ClientSecrets;
//# sourceMappingURL=client-secrets.js.map