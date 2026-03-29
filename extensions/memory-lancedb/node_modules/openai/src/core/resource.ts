// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import type { OpenAI } from '../client';

export abstract class APIResource {
  protected _client: OpenAI;

  constructor(client: OpenAI) {
    this._client = client;
  }
}
