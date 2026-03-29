// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import * as CallsAPI from "./calls.mjs";
import { Calls } from "./calls.mjs";
import * as ClientSecretsAPI from "./client-secrets.mjs";
import { ClientSecrets, } from "./client-secrets.mjs";
export class Realtime extends APIResource {
    constructor() {
        super(...arguments);
        this.clientSecrets = new ClientSecretsAPI.ClientSecrets(this._client);
        this.calls = new CallsAPI.Calls(this._client);
    }
}
Realtime.ClientSecrets = ClientSecrets;
Realtime.Calls = Calls;
//# sourceMappingURL=realtime.mjs.map