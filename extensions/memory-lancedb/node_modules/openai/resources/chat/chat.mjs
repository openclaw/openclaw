// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import * as CompletionsAPI from "./completions/completions.mjs";
import { Completions, } from "./completions/completions.mjs";
export class Chat extends APIResource {
    constructor() {
        super(...arguments);
        this.completions = new CompletionsAPI.Completions(this._client);
    }
}
Chat.Completions = Completions;
//# sourceMappingURL=chat.mjs.map