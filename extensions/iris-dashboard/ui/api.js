/**
 * Iris Dashboard — API client
 * Communicates with /iris-dashboard/api/* endpoints.
 */

export class DashboardApiClient {
  /** @param {string} base - e.g. "/iris-dashboard/api" */
  constructor(base, apiKey = "") {
    this.base = base.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  /** Common headers for mutable requests */
  _authHeaders() {
    const h = { "Content-Type": "application/json" };
    if (this.apiKey) h["X-Iris-Dashboard-Key"] = this.apiKey;
    return h;
  }

  /** Parse response or throw with structured error */
  async _parse(res) {
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}: invalid JSON response`);
    }
    if (!body.ok) {
      const msg = body.error?.message ?? body.error ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body.data;
  }

  /**
   * List tasks with optional filters.
   * @param {Object} params
   * @param {string} [params.status]
   * @param {string} [params.categoria]
   * @param {string} [params.pessoa]
   * @param {string} [params.search]
   * @param {number} [params.limit]
   * @param {number} [params.offset]
   * @param {boolean} [params.include_deleted]
   * @param {string} [params.sort_by]
   * @param {string} [params.sort_dir]
   * @returns {Promise<{items: object[], page: {limit: number, offset: number, total: number}}>}
   */
  async listTasks(params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    }
    const url = `${this.base}/tasks${q.size ? "?" + q.toString() : ""}`;
    const res = await fetch(url);
    return this._parse(res);
  }

  /**
   * Fetch a single task by ID.
   * @param {string} id
   * @returns {Promise<object>}
   */
  async fetchTask(id) {
    const res = await fetch(`${this.base}/tasks/${encodeURIComponent(id)}`);
    return this._parse(res);
  }

  /**
   * Create a new task.
   * @param {object} input
   * @returns {Promise<{task: object}>}
   */
  async createTask(input) {
    const res = await fetch(`${this.base}/tasks`, {
      method: "POST",
      headers: this._authHeaders(),
      body: JSON.stringify(input),
    });
    return this._parse(res);
  }

  /**
   * Update a task (partial).
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<{task: object}>}
   */
  async updateTask(id, patch) {
    const res = await fetch(`${this.base}/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: this._authHeaders(),
      body: JSON.stringify(patch),
    });
    return this._parse(res);
  }

  /**
   * Soft-delete a task.
   * @param {string} id
   * @returns {Promise<{id: string, deleted_at: string}>}
   */
  async deleteTask(id) {
    const res = await fetch(`${this.base}/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this._authHeaders(),
    });
    return this._parse(res);
  }

  /**
   * Restore a soft-deleted task.
   * @param {string} id
   * @returns {Promise<{task: object}>}
   */
  async restoreTask(id) {
    const res = await fetch(`${this.base}/tasks/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      headers: this._authHeaders(),
    });
    return this._parse(res);
  }
}
