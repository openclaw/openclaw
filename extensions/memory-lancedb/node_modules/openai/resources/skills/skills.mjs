// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import * as ContentAPI from "./content.mjs";
import { Content } from "./content.mjs";
import * as VersionsAPI from "./versions/versions.mjs";
import { Versions, } from "./versions/versions.mjs";
import { CursorPage } from "../../core/pagination.mjs";
import { maybeMultipartFormRequestOptions } from "../../internal/uploads.mjs";
import { path } from "../../internal/utils/path.mjs";
export class Skills extends APIResource {
    constructor() {
        super(...arguments);
        this.content = new ContentAPI.Content(this._client);
        this.versions = new VersionsAPI.Versions(this._client);
    }
    /**
     * Create a new skill.
     */
    create(body = {}, options) {
        return this._client.post('/skills', maybeMultipartFormRequestOptions({ body, ...options }, this._client));
    }
    /**
     * Get a skill by its ID.
     */
    retrieve(skillID, options) {
        return this._client.get(path `/skills/${skillID}`, options);
    }
    /**
     * Update the default version pointer for a skill.
     */
    update(skillID, body, options) {
        return this._client.post(path `/skills/${skillID}`, { body, ...options });
    }
    /**
     * List all skills for the current project.
     */
    list(query = {}, options) {
        return this._client.getAPIList('/skills', (CursorPage), { query, ...options });
    }
    /**
     * Delete a skill by its ID.
     */
    delete(skillID, options) {
        return this._client.delete(path `/skills/${skillID}`, options);
    }
}
Skills.Content = Content;
Skills.Versions = Versions;
//# sourceMappingURL=skills.mjs.map