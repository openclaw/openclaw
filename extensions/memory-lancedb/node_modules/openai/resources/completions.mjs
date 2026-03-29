// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../core/resource.mjs";
/**
 * Given a prompt, the model will return one or more predicted completions, and can also return the probabilities of alternative tokens at each position.
 */
export class Completions extends APIResource {
    create(body, options) {
        return this._client.post('/completions', { body, ...options, stream: body.stream ?? false });
    }
}
//# sourceMappingURL=completions.mjs.map