// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as ContentAPI from './content';
import { Content } from './content';
import * as VersionsAPI from './versions/versions';
import {
  DeletedSkillVersion,
  SkillVersion,
  SkillVersionList,
  SkillVersionsPage,
  VersionCreateParams,
  VersionDeleteParams,
  VersionListParams,
  VersionRetrieveParams,
  Versions,
} from './versions/versions';
import { APIPromise } from '../../core/api-promise';
import { CursorPage, type CursorPageParams, PagePromise } from '../../core/pagination';
import { type Uploadable } from '../../core/uploads';
import { RequestOptions } from '../../internal/request-options';
import { maybeMultipartFormRequestOptions } from '../../internal/uploads';
import { path } from '../../internal/utils/path';

export class Skills extends APIResource {
  content: ContentAPI.Content = new ContentAPI.Content(this._client);
  versions: VersionsAPI.Versions = new VersionsAPI.Versions(this._client);

  /**
   * Create a new skill.
   */
  create(body: SkillCreateParams | null | undefined = {}, options?: RequestOptions): APIPromise<Skill> {
    return this._client.post('/skills', maybeMultipartFormRequestOptions({ body, ...options }, this._client));
  }

  /**
   * Get a skill by its ID.
   */
  retrieve(skillID: string, options?: RequestOptions): APIPromise<Skill> {
    return this._client.get(path`/skills/${skillID}`, options);
  }

  /**
   * Update the default version pointer for a skill.
   */
  update(skillID: string, body: SkillUpdateParams, options?: RequestOptions): APIPromise<Skill> {
    return this._client.post(path`/skills/${skillID}`, { body, ...options });
  }

  /**
   * List all skills for the current project.
   */
  list(
    query: SkillListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<SkillsPage, Skill> {
    return this._client.getAPIList('/skills', CursorPage<Skill>, { query, ...options });
  }

  /**
   * Delete a skill by its ID.
   */
  delete(skillID: string, options?: RequestOptions): APIPromise<DeletedSkill> {
    return this._client.delete(path`/skills/${skillID}`, options);
  }
}

export type SkillsPage = CursorPage<Skill>;

export interface DeletedSkill {
  id: string;

  deleted: boolean;

  object: 'skill.deleted';
}

export interface Skill {
  /**
   * Unique identifier for the skill.
   */
  id: string;

  /**
   * Unix timestamp (seconds) for when the skill was created.
   */
  created_at: number;

  /**
   * Default version for the skill.
   */
  default_version: string;

  /**
   * Description of the skill.
   */
  description: string;

  /**
   * Latest version for the skill.
   */
  latest_version: string;

  /**
   * Name of the skill.
   */
  name: string;

  /**
   * The object type, which is `skill`.
   */
  object: 'skill';
}

export interface SkillList {
  /**
   * A list of items
   */
  data: Array<Skill>;

  /**
   * The ID of the first item in the list.
   */
  first_id: string | null;

  /**
   * Whether there are more items available.
   */
  has_more: boolean;

  /**
   * The ID of the last item in the list.
   */
  last_id: string | null;

  /**
   * The type of object returned, must be `list`.
   */
  object: 'list';
}

export interface SkillCreateParams {
  /**
   * Skill files to upload (directory upload) or a single zip file.
   */
  files?: Array<Uploadable> | Uploadable;
}

export interface SkillUpdateParams {
  /**
   * The skill version number to set as default.
   */
  default_version: string;
}

export interface SkillListParams extends CursorPageParams {
  /**
   * Sort order of results by timestamp. Use `asc` for ascending order or `desc` for
   * descending order.
   */
  order?: 'asc' | 'desc';
}

Skills.Content = Content;
Skills.Versions = Versions;

export declare namespace Skills {
  export {
    type DeletedSkill as DeletedSkill,
    type Skill as Skill,
    type SkillList as SkillList,
    type SkillsPage as SkillsPage,
    type SkillCreateParams as SkillCreateParams,
    type SkillUpdateParams as SkillUpdateParams,
    type SkillListParams as SkillListParams,
  };

  export { Content as Content };

  export {
    Versions as Versions,
    type DeletedSkillVersion as DeletedSkillVersion,
    type SkillVersion as SkillVersion,
    type SkillVersionList as SkillVersionList,
    type SkillVersionsPage as SkillVersionsPage,
    type VersionCreateParams as VersionCreateParams,
    type VersionRetrieveParams as VersionRetrieveParams,
    type VersionListParams as VersionListParams,
    type VersionDeleteParams as VersionDeleteParams,
  };
}
