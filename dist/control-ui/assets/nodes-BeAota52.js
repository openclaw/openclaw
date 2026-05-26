import{h as e,o as t,p as n,r}from"./string-coerce-B303fUwC.js";import{d as i,r as a,t as o}from"./format-CMbyKmU8.js";import{H as s}from"./index-Bsr3gFG6.js";function c(...e){let t=new Set;for(let n of e){if(!n)continue;if(Array.isArray(n)){for(let e of n){let n=e.trim();n&&t.add(n)}continue}let e=n.trim();e&&t.add(e)}return[...t].toSorted()}function l(e,t){let n=new Set(e);return t.every(e=>n.has(e))}function u(e){return{roles:c(e.roles,e.role),scopes:s(e.scopes)}}function d(e){let t=c(e.roles,e.role),n=Array.isArray(e.tokens)?e.tokens:e.tokens?Object.values(e.tokens):void 0;return{roles:n===void 0?t:c(n.filter(e=>!e.revokedAtMs).flatMap(e=>e.role??[])).filter(e=>t.includes(e)),scopes:s(e.scopes)}}function f(e,t){let n=u(e),r=t?d(t):null;return r?l(r.roles,n.roles)?l(r.scopes,n.scopes)?{kind:`re-approval`,requested:n,approved:r}:{kind:`scope-upgrade`,requested:n,approved:r}:{kind:`role-upgrade`,requested:n,approved:r}:{kind:`new-pairing`,requested:n,approved:null}}function p(e){let t=e?.agents??{},n=Array.isArray(t.list)?t.list:[],i=[];return n.forEach((e,t)=>{if(!e||typeof e!=`object`)return;let n=e,a=r(n.id)??``;if(!a)return;let o=r(n.name),s=n.default===!0;i.push({id:a,name:o,isDefault:s,index:t,record:n})}),i}function m(e,t){let n=new Set(t),i=[];for(let t of e){if(!(Array.isArray(t.commands)?t.commands:[]).some(e=>n.has(String(e))))continue;let e=r(t.nodeId)??``;if(!e)continue;let a=r(t.displayName)??e;i.push({id:e,label:a===e?e:`${a} · ${e}`})}return i.sort((e,t)=>e.label.localeCompare(t.label)),i}var h=`__defaults__`,g=[{value:`deny`,label:`Deny`},{value:`allowlist`,label:`Allowlist`},{value:`full`,label:`Full`}],_=[{value:`off`,label:`Off`},{value:`on-miss`,label:`On miss`},{value:`always`,label:`Always`}];function v(e){return e===`allowlist`||e===`full`||e===`deny`?e:`deny`}function y(e){return e===`always`||e===`off`||e===`on-miss`?e:`on-miss`}function b(e){let t=e?.defaults??{};return{security:v(t.security),ask:y(t.ask),askFallback:v(t.askFallback??`deny`),autoAllowSkills:t.autoAllowSkills??!1}}function x(e){return p(e).map(e=>({id:e.id,name:e.name,isDefault:e.isDefault}))}function S(e,t){let n=x(e),r=Object.keys(t?.agents??{}),i=new Map;n.forEach(e=>i.set(e.id,e)),r.forEach(e=>{i.has(e)||i.set(e,{id:e})});let a=Array.from(i.values());return a.length===0&&a.push({id:`main`,isDefault:!0}),a.sort((e,t)=>{if(e.isDefault&&!t.isDefault)return-1;if(!e.isDefault&&t.isDefault)return 1;let n=e.name?.trim()?e.name:e.id,r=t.name?.trim()?t.name:t.id;return n.localeCompare(r)}),a}function C(e,t){return e===h?h:e&&t.some(t=>t.id===e)?e:h}function w(e){let t=e.execApprovalsForm??e.execApprovalsSnapshot?.file??null,n=!!t,r=b(t),i=S(e.configForm,t),a=j(e.nodes),o=e.execApprovalsTarget,s=o===`node`&&e.execApprovalsTargetNodeId?e.execApprovalsTargetNodeId:null;o===`node`&&s&&!a.some(e=>e.id===s)&&(s=null);let c=C(e.execApprovalsSelectedAgent,i),l=c===h?null:(t?.agents??{})[c]??null,u=Array.isArray(l?.allowlist)?l.allowlist??[]:[];return{ready:n,disabled:e.execApprovalsSaving||e.execApprovalsLoading,dirty:e.execApprovalsDirty,loading:e.execApprovalsLoading,saving:e.execApprovalsSaving,form:t,defaults:r,selectedScope:c,selectedAgent:l,agents:i,allowlist:u,target:o,targetNodeId:s,targetNodes:a,onSelectScope:e.onExecApprovalsSelectAgent,onSelectTarget:e.onExecApprovalsTargetChange,onPatch:e.onExecApprovalsPatch,onRemove:e.onExecApprovalsRemove,onLoad:e.onLoadExecApprovals,onSave:e.onSaveExecApprovals}}function T(r){let i=r.ready,a=r.target!==`node`||!!r.targetNodeId;return e`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Exec approvals</div>
          <div class="card-sub">
            Allowlist and approval policy for <span class="mono">exec host=gateway/node</span>.
          </div>
        </div>
        <button
          class="btn"
          ?disabled=${r.disabled||!r.dirty||!a}
          @click=${r.onSave}
        >
          ${r.saving?`Saving…`:`Save`}
        </button>
      </div>

      ${E(r)}
      ${i?e`
            ${D(r)} ${O(r)}
            ${r.selectedScope===h?n:k(r)}
          `:e`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load exec approvals to edit allowlists.</div>
            <button class="btn" ?disabled=${r.loading||!a} @click=${r.onLoad}>
              ${r.loading?t(`common.loading`):t(`common.loadApprovals`)}
            </button>
          </div>`}
    </section>
  `}function E(t){let r=t.targetNodes.length>0,i=t.targetNodeId??``;return e`
    <div class="list" style="margin-top: 12px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Target</div>
          <div class="list-sub">Gateway edits local approvals; node edits the selected node.</div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Host</span>
            <select
              ?disabled=${t.disabled}
              @change=${e=>{if(e.target.value===`node`){let e=t.targetNodes[0]?.id??null;t.onSelectTarget(`node`,i||e)}else t.onSelectTarget(`gateway`,null)}}
            >
              <option value="gateway" ?selected=${t.target===`gateway`}>Gateway</option>
              <option value="node" ?selected=${t.target===`node`}>Node</option>
            </select>
          </label>
          ${t.target===`node`?e`
                <label class="field">
                  <span>Node</span>
                  <select
                    ?disabled=${t.disabled||!r}
                    @change=${e=>{let n=e.target.value.trim();t.onSelectTarget(`node`,n||null)}}
                  >
                    <option value="" ?selected=${i===``}>Select node</option>
                    ${t.targetNodes.map(t=>e`<option value=${t.id} ?selected=${i===t.id}>
                          ${t.label}
                        </option>`)}
                  </select>
                </label>
              `:n}
        </div>
      </div>
      ${t.target===`node`&&!r?e` <div class="muted">No nodes advertise exec approvals yet.</div> `:n}
    </div>
  `}function D(t){return e`
    <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
      <span class="label">Scope</span>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <button
          class="btn btn--sm ${t.selectedScope===h?`active`:``}"
          @click=${()=>t.onSelectScope(h)}
        >
          Defaults
        </button>
        ${t.agents.map(n=>{let r=n.name?.trim()?`${n.name} (${n.id})`:n.id;return e`
            <button
              class="btn btn--sm ${t.selectedScope===n.id?`active`:``}"
              @click=${()=>t.onSelectScope(n.id)}
            >
              ${r}
            </button>
          `})}
      </div>
    </div>
  `}function O(t){let r=t.selectedScope===h,i=t.defaults,a=t.selectedAgent??{},o=r?[`defaults`]:[`agents`,t.selectedScope],s=typeof a.security==`string`?a.security:void 0,c=typeof a.ask==`string`?a.ask:void 0,l=typeof a.askFallback==`string`?a.askFallback:void 0,u=r?i.security:s??`__default__`,d=r?i.ask:c??`__default__`,f=r?i.askFallback:l??`__default__`,p=typeof a.autoAllowSkills==`boolean`?a.autoAllowSkills:void 0,m=p??i.autoAllowSkills,v=p==null;return e`
    <div class="list" style="margin-top: 16px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Security</div>
          <div class="list-sub">
            ${r?`Default security mode.`:`Default: ${i.security}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${t.disabled}
              @change=${e=>{let n=e.target.value;!r&&n===`__default__`?t.onRemove([...o,`security`]):t.onPatch([...o,`security`],n)}}
            >
              ${r?n:e`<option value="__default__" ?selected=${u===`__default__`}>
                    Use default (${i.security})
                  </option>`}
              ${g.map(t=>e`<option value=${t.value} ?selected=${u===t.value}>
                    ${t.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask</div>
          <div class="list-sub">
            ${r?`Default prompt policy.`:`Default: ${i.ask}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${t.disabled}
              @change=${e=>{let n=e.target.value;!r&&n===`__default__`?t.onRemove([...o,`ask`]):t.onPatch([...o,`ask`],n)}}
            >
              ${r?n:e`<option value="__default__" ?selected=${d===`__default__`}>
                    Use default (${i.ask})
                  </option>`}
              ${_.map(t=>e`<option value=${t.value} ?selected=${d===t.value}>
                    ${t.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask fallback</div>
          <div class="list-sub">
            ${r?`Applied when the UI prompt is unavailable.`:`Default: ${i.askFallback}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Fallback</span>
            <select
              ?disabled=${t.disabled}
              @change=${e=>{let n=e.target.value;!r&&n===`__default__`?t.onRemove([...o,`askFallback`]):t.onPatch([...o,`askFallback`],n)}}
            >
              ${r?n:e`<option value="__default__" ?selected=${f===`__default__`}>
                    Use default (${i.askFallback})
                  </option>`}
              ${g.map(t=>e`<option value=${t.value} ?selected=${f===t.value}>
                    ${t.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Auto-allow skill CLIs</div>
          <div class="list-sub">
            ${r?`Allow skill executables listed by the Gateway.`:v?`Using default (${i.autoAllowSkills?`on`:`off`}).`:`Override (${m?`on`:`off`}).`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Enabled</span>
            <input
              type="checkbox"
              ?disabled=${t.disabled}
              .checked=${m}
              @change=${e=>{let n=e.target;t.onPatch([...o,`autoAllowSkills`],n.checked)}}
            />
          </label>
          ${!r&&!v?e`<button
                class="btn btn--sm"
                ?disabled=${t.disabled}
                @click=${()=>t.onRemove([...o,`autoAllowSkills`])}
              >
                Use default
              </button>`:n}
        </div>
      </div>
    </div>
  `}function k(t){let n=[`agents`,t.selectedScope,`allowlist`],r=t.allowlist;return e`
    <div class="row" style="margin-top: 18px; justify-content: space-between;">
      <div>
        <div class="card-title">Allowlist</div>
        <div class="card-sub">Case-insensitive glob patterns.</div>
      </div>
      <button
        class="btn btn--sm"
        ?disabled=${t.disabled}
        @click=${()=>{let e=[...r,{pattern:``}];t.onPatch(n,e)}}
      >
        Add pattern
      </button>
    </div>
    <div class="list" style="margin-top: 12px;">
      ${r.length===0?e` <div class="muted">No allowlist entries yet.</div> `:r.map((e,n)=>A(t,e,n))}
    </div>
  `}function A(t,r,a){let s=r.lastUsedAt?i(r.lastUsedAt):`never`,c=r.lastUsedCommand?o(r.lastUsedCommand,120):null,l=r.lastResolvedPath?o(r.lastResolvedPath,120):null;return e`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${r.pattern?.trim()?r.pattern:`New pattern`}</div>
        <div class="list-sub">Last used: ${s}</div>
        ${c?e`<div class="list-sub mono">${c}</div>`:n}
        ${l?e`<div class="list-sub mono">${l}</div>`:n}
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Pattern</span>
          <input
            type="text"
            .value=${r.pattern??``}
            ?disabled=${t.disabled}
            @input=${e=>{let n=e.target;t.onPatch([`agents`,t.selectedScope,`allowlist`,a,`pattern`],n.value)}}
          />
        </label>
        <button
          class="btn btn--sm danger"
          ?disabled=${t.disabled}
          @click=${()=>{if(t.allowlist.length<=1){t.onRemove([`agents`,t.selectedScope,`allowlist`]);return}t.onRemove([`agents`,t.selectedScope,`allowlist`,a])}}
        >
          Remove
        </button>
      </div>
    </div>
  `}function j(e){return m(e,[`system.execApprovals.get`,`system.execApprovals.set`])}function M(n){let r=B(n);return e`
    ${T(w(n))} ${V(r)} ${N(n)}
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Nodes</div>
          <div class="card-sub">Paired devices and live links.</div>
        </div>
        <button class="btn" ?disabled=${n.loading} @click=${n.onRefresh}>
          ${n.loading?t(`common.loading`):t(`common.refresh`)}
        </button>
      </div>
      <div class="list" style="margin-top: 16px;">
        ${n.nodes.length===0?e` <div class="muted">No nodes found.</div> `:n.nodes.map(e=>G(e))}
      </div>
    </section>
  `}function N(i){let a=i.devicesList??{pending:[],paired:[]},o=Array.isArray(a.pending)?a.pending:[],s=Array.isArray(a.paired)?a.paired:[],c=new Map(s.map(e=>[r(e.deviceId),e]).filter(e=>!!e[0]));return e`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Devices</div>
          <div class="card-sub">Pairing requests + role tokens.</div>
        </div>
        <button class="btn" ?disabled=${i.devicesLoading} @click=${i.onDevicesRefresh}>
          ${i.devicesLoading?t(`common.loading`):t(`common.refresh`)}
        </button>
      </div>
      ${i.devicesError?e`<div class="callout danger" style="margin-top: 12px;">${i.devicesError}</div>`:n}
      <div class="list" style="margin-top: 16px;">
        ${o.length>0?e`
              <div class="muted" style="margin-bottom: 8px;">Pending</div>
              ${o.map(e=>L(e,i,P(c,e)))}
            `:n}
        ${s.length>0?e`
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">Paired</div>
              ${s.map(e=>R(e,i))}
            `:n}
        ${o.length===0&&s.length===0?e` <div class="muted">No paired devices.</div> `:n}
      </div>
    </section>
  `}function P(e,t){let n=r(t.deviceId);if(!n)return;let i=e.get(n);if(!i)return;let a=r(t.publicKey),o=r(i.publicKey);if(!(a&&o&&a!==o))return i}function F(e){return e?`roles: ${a(e.roles)} · scopes: ${a(e.scopes)}`:`none`}function I(e){switch(e){case`scope-upgrade`:return`scope upgrade requires approval`;case`role-upgrade`:return`role upgrade requires approval`;case`re-approval`:return`reconnect details changed; approval required`;case`new-pairing`:return`new device pairing request`}throw Error(`unsupported pending approval kind`)}function L(a,o,s){let c=r(a.displayName)||a.deviceId,l=typeof a.ts==`number`?i(a.ts):t(`common.na`),u=f(a,s),d=a.isRepair?` · repair`:``,p=a.remoteIp?` · ${a.remoteIp}`:``;return e`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${c}</div>
        <div class="list-sub">${a.deviceId}${p}</div>
        <div class="muted" style="margin-top: 6px;">
          ${I(u.kind)} · requested ${l}${d}
        </div>
        <div class="muted" style="margin-top: 6px;">
          requested: ${F(u.requested)}
        </div>
        ${u.approved?e`
              <div class="muted" style="margin-top: 6px;">
                approved now: ${F(u.approved)}
              </div>
            `:n}
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm primary" @click=${()=>o.onDeviceApprove(a.requestId)}>
            Approve
          </button>
          <button class="btn btn--sm" @click=${()=>o.onDeviceReject(a.requestId)}>
            Reject
          </button>
        </div>
      </div>
    </div>
  `}function R(t,n){let i=r(t.displayName)||t.deviceId,o=t.remoteIp?` · ${t.remoteIp}`:``,s=`roles: ${a(t.roles)}`,c=`scopes: ${a(t.scopes)}`,l=Array.isArray(t.tokens)?t.tokens:[];return e`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${i}</div>
        <div class="list-sub">${t.deviceId}${o}</div>
        <div class="muted" style="margin-top: 6px;">${s} · ${c}</div>
        ${l.length===0?e` <div class="muted" style="margin-top: 6px">Tokens: none</div> `:e`
              <div class="muted" style="margin-top: 10px;">Tokens</div>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
                ${l.map(e=>z(t.deviceId,e,n))}
              </div>
            `}
      </div>
    </div>
  `}function z(t,r,o){let s=r.revokedAtMs?`revoked`:`active`,c=`scopes: ${a(r.scopes)}`,l=i(r.rotatedAtMs??r.createdAtMs??r.lastUsedAtMs??null);return e`
    <div class="row" style="justify-content: space-between; gap: 8px;">
      <div class="list-sub">${r.role} · ${s} · ${c} · ${l}</div>
      <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
        <button
          class="btn btn--sm"
          @click=${()=>o.onDeviceRotate(t,r.role,r.scopes)}
        >
          Rotate
        </button>
        ${r.revokedAtMs?n:e`
              <button
                class="btn btn--sm danger"
                @click=${()=>o.onDeviceRevoke(t,r.role)}
              >
                Revoke
              </button>
            `}
      </div>
    </div>
  `}function B(e){let t=e.configForm,n=U(e.nodes),{defaultBinding:r,agents:i}=W(t);return{ready:!!t,disabled:e.configSaving||e.configFormMode===`raw`,configDirty:e.configDirty,configLoading:e.configLoading,configSaving:e.configSaving,defaultBinding:r,agents:i,nodes:n,onBindDefault:e.onBindDefault,onBindAgent:e.onBindAgent,onSave:e.onSaveBindings,onLoadConfig:e.onLoadConfig,formMode:e.configFormMode}}function V(r){let i=r.nodes.length>0,a=r.defaultBinding??``;return e`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">${t(`nodes.binding.execNodeBinding`)}</div>
          <div class="card-sub">${t(`nodes.binding.execNodeBindingSubtitle`)}</div>
        </div>
        <button
          class="btn"
          ?disabled=${r.disabled||!r.configDirty}
          @click=${r.onSave}
        >
          ${r.configSaving?t(`common.saving`):t(`common.save`)}
        </button>
      </div>

      ${r.formMode===`raw`?e`
            <div class="callout warn" style="margin-top: 12px">
              ${t(`nodes.binding.formModeHint`)}
            </div>
          `:n}
      ${r.ready?e`
            <div class="list" style="margin-top: 16px;">
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">${t(`nodes.binding.defaultBinding`)}</div>
                  <div class="list-sub">${t(`nodes.binding.defaultBindingHint`)}</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>${t(`nodes.binding.node`)}</span>
                    <select
                      ?disabled=${r.disabled||!i}
                      @change=${e=>{let t=e.target.value.trim();r.onBindDefault(t||null)}}
                    >
                      <option value="" ?selected=${a===``}>Any node</option>
                      ${r.nodes.map(t=>e`<option value=${t.id} ?selected=${a===t.id}>
                            ${t.label}
                          </option>`)}
                    </select>
                  </label>
                  ${i?n:e` <div class="muted">No nodes with system.run available.</div> `}
                </div>
              </div>

              ${r.agents.length===0?e` <div class="muted">No agents found.</div> `:r.agents.map(e=>H(e,r))}
            </div>
          `:e`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">${t(`nodes.binding.loadConfigHint`)}</div>
            <button class="btn" ?disabled=${r.configLoading} @click=${r.onLoadConfig}>
              ${r.configLoading?t(`common.loading`):t(`common.loadConfig`)}
            </button>
          </div>`}
    </section>
  `}function H(t,n){let r=t.binding??`__default__`,i=t.name?.trim()?`${t.name} (${t.id})`:t.id,a=n.nodes.length>0;return e`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${i}</div>
        <div class="list-sub">
          ${t.isDefault?`default agent`:`agent`} ·
          ${r===`__default__`?`uses default (${n.defaultBinding??`any`})`:`override: ${t.binding}`}
        </div>
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Binding</span>
          <select
            ?disabled=${n.disabled||!a}
            @change=${e=>{let r=e.target.value.trim();n.onBindAgent(t.index,r===`__default__`?null:r)}}
          >
            <option value="__default__" ?selected=${r===`__default__`}>
              Use default
            </option>
            ${n.nodes.map(t=>e`<option value=${t.id} ?selected=${r===t.id}>
                  ${t.label}
                </option>`)}
          </select>
        </label>
      </div>
    </div>
  `}function U(e){return m(e,[`system.run`])}function W(e){let t={id:`main`,name:void 0,index:0,isDefault:!0,binding:null};if(!e||typeof e!=`object`)return{defaultBinding:null,agents:[t]};let n=(e.tools??{}).exec??{},r=typeof n.node==`string`&&n.node.trim()?n.node.trim():null,i=e.agents??{};if(!Array.isArray(i.list)||i.list.length===0)return{defaultBinding:r,agents:[t]};let a=p(e).map(e=>{let t=(e.record.tools??{}).exec??{},n=typeof t.node==`string`&&t.node.trim()?t.node.trim():null;return{id:e.id,name:e.name,index:e.index,isDefault:e.isDefault,binding:n}});return a.length===0&&a.push(t),{defaultBinding:r,agents:a}}function G(t){let n=!!t.connected,r=!!t.paired,i=typeof t.displayName==`string`&&t.displayName.trim()||(typeof t.nodeId==`string`?t.nodeId:`unknown`),a=Array.isArray(t.caps)?t.caps:[],o=Array.isArray(t.commands)?t.commands:[];return e`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${i}</div>
        <div class="list-sub">
          ${typeof t.nodeId==`string`?t.nodeId:``}
          ${typeof t.remoteIp==`string`?` · ${t.remoteIp}`:``}
          ${typeof t.version==`string`?` · ${t.version}`:``}
        </div>
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${r?`paired`:`unpaired`}</span>
          <span class="chip ${n?`chip-ok`:`chip-warn`}">
            ${n?`connected`:`offline`}
          </span>
          ${a.slice(0,12).map(t=>e`<span class="chip">${String(t)}</span>`)}
          ${o.slice(0,8).map(t=>e`<span class="chip">${String(t)}</span>`)}
        </div>
      </div>
    </div>
  `}export{M as renderNodes};
//# sourceMappingURL=nodes-BeAota52.js.map