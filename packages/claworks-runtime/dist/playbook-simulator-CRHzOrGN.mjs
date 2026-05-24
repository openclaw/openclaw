//#region src/planes/orch/playbook-simulator.ts
function createMockObjectStore() {
	const store = /* @__PURE__ */ new Map();
	function getTypeMap(typeName) {
		if (!store.has(typeName)) store.set(typeName, /* @__PURE__ */ new Map());
		return store.get(typeName);
	}
	function makeEntry(typeName, id, data) {
		const now = /* @__PURE__ */ new Date();
		return {
			...data,
			id,
			_type: typeName,
			_version: 1,
			_createdAt: now,
			_updatedAt: now
		};
	}
	return {
		async query(typeName, opts) {
			let items = [...getTypeMap(typeName).values()];
			if (opts?.filter) for (const [k, v] of Object.entries(opts.filter)) items = items.filter((item) => item[k] === v);
			const limit = opts?.limit ?? 50;
			return { items: items.slice(0, limit) };
		},
		async get(typeName, id) {
			return getTypeMap(typeName).get(id) ?? null;
		},
		async create(typeName, data, _ctx) {
			const id = String(data.id ?? `mock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
			const entry = makeEntry(typeName, id, {
				...data,
				id
			});
			getTypeMap(typeName).set(id, entry);
			return entry;
		},
		async update(typeName, id, patch) {
			const map = getTypeMap(typeName);
			const existing = map.get(id) ?? makeEntry(typeName, id, {});
			const now = /* @__PURE__ */ new Date();
			const updated = {
				...existing,
				...patch,
				id,
				_type: typeName,
				_version: existing._version + 1,
				_createdAt: existing._createdAt,
				_updatedAt: now
			};
			map.set(id, updated);
			return updated;
		},
		async upsert(typeName, id, data) {
			if (getTypeMap(typeName).get(id)) return this.update(typeName, id, data);
			return this.create(typeName, {
				...data,
				id
			});
		},
		async delete(typeName, id) {
			getTypeMap(typeName).delete(id);
		},
		async executeAction(typeName, id, actionType, params, _ctx) {
			return {
				status: "mock_ok",
				typeName,
				id,
				actionType,
				params
			};
		},
		async queryTimeSeries(typeName, opts) {
			return {
				type_name: typeName,
				group_by_period: opts?.group_by_period ?? "day",
				aggregate_fn: opts?.aggregate_fn ?? "count",
				aggregate_field: opts?.aggregate_field,
				from: opts?.from,
				to: opts?.to,
				buckets: [],
				total_count: 0,
				total_value: 0
			};
		},
		dumpAll() {
			const result = {};
			for (const [type, map] of store.entries()) result[type] = [...map.values()];
			return result;
		}
	};
}
/**
* 创建 PlaybookSimulator。
*
* @param runPlaybook 用于触发 Playbook 的函数（由外部注入，避免引入 PlaybookEngine 全量依赖）
*   函数签名：(playbookId, vars, event, mockStore) => Promise<{ steps, error? }>
*/
function createPlaybookSimulator(runPlaybook) {
	return { async simulate(playbookId, initialVars = {}, triggerEvent = {}) {
		const t0 = Date.now();
		const mockStore = createMockObjectStore();
		try {
			const result = await runPlaybook(playbookId, initialVars, triggerEvent, mockStore);
			const dump = mockStore.dumpAll();
			const objectsCreated = Object.entries(dump).flatMap(([type, entries]) => entries.map((e) => {
				const { _type, _version, _createdAt, _updatedAt, ...fields } = e;
				return {
					type,
					id: e.id,
					data: fields
				};
			}));
			return {
				playbook_id: playbookId,
				status: result.error ? "error" : "ok",
				steps: result.steps,
				side_effects: {
					objects_created: objectsCreated,
					objects_updated: [],
					objects_deleted: [],
					events_would_publish: result.steps.filter((s) => s.type === "event" || s.type === "notify").map((s) => String(s.name ?? s.type)),
					notifications_would_send: result.steps.filter((s) => s.type === "notify").length
				},
				error: result.error,
				duration_ms: Date.now() - t0
			};
		} catch (e) {
			return {
				playbook_id: playbookId,
				status: "error",
				steps: [],
				side_effects: {
					objects_created: [],
					objects_updated: [],
					objects_deleted: [],
					events_would_publish: [],
					notifications_would_send: 0
				},
				error: String(e),
				duration_ms: Date.now() - t0
			};
		}
	} };
}
//#endregion
export { createPlaybookSimulator };
