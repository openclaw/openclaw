import{$ as e,O as t,T as n,Z as r,et as i,nt as a,rt as o,w as s}from"./index-C8qrCYNH.js";function c(...e){let t=new Set;for(let n of e){if(!n)continue;if(Array.isArray(n)){for(let e of n){let n=e.trim();n&&t.add(n)}continue}let e=n.trim();e&&t.add(e)}return[...t].toSorted()}function l(e,t){let n=new Set(e);return t.every(e=>n.has(e))}function u(e){return{roles:c(e.roles,e.role),scopes:r(e.scopes)}}function d(e){let t=c(e.roles,e.role),n=Array.isArray(e.tokens)?e.tokens:e.tokens?Object.values(e.tokens):void 0;return{roles:n===void 0?t:c(n.filter(e=>!e.revokedAtMs).flatMap(e=>e.role??[])).filter(e=>t.includes(e)),scopes:r(e.scopes)}}function f(e,t){let n=u(e),r=t?d(t):null;return r?l(r.roles,n.roles)?l(r.scopes,n.scopes)?{kind:`re-approval`,requested:n,approved:r}:{kind:`scope-upgrade`,requested:n,approved:r}:{kind:`role-upgrade`,requested:n,approved:r}:{kind:`new-pairing`,requested:n,approved:null}}function p(t){let n=t?.agents??{},r=Array.isArray(n.list)?n.list:[],i=[];return r.forEach((t,n)=>{if(!t||typeof t!=`object`)return;let r=t,a=e(r.id)??``;if(!a)return;let o=e(r.name),s=r.default===!0;i.push({id:a,name:o,isDefault:s,index:n,record:r})}),i}function m(t,n){let r=new Set(n),i=[];for(let n of t){if(!(Array.isArray(n.commands)?n.commands:[]).some(e=>r.has(String(e))))continue;let t=e(n.nodeId)??``;if(!t)continue;let a=e(n.displayName)??t;i.push({id:t,label:a===t?t:`${a} · ${t}`})}return i.sort((e,t)=>e.label.localeCompare(t.label)),i}var h=`__defaults__`,g=[{value:`deny`,label:`Deny`},{value:`allowlist`,label:`Allowlist`},{value:`full`,label:`Full`}],_=[{value:`off`,label:`Off`},{value:`on-miss`,label:`On miss`},{value:`always`,label:`Always`}];function v(e){return e===`allowlist`||e===`full`||e===`deny`?e:`deny`}function y(e){return e===`always`||e===`off`||e===`on-miss`?e:`on-miss`}function b(e){let t=e?.defaults??{};return{security:v(t.security),ask:y(t.ask),askFallback:v(t.askFallback??`deny`),autoAllowSkills:t.autoAllowSkills??!1}}function x(e){return p(e).map(e=>({id:e.id,name:e.name,isDefault:e.isDefault}))}function S(e,t){let n=x(e),r=Object.keys(t?.agents??{}),i=new Map;n.forEach(e=>i.set(e.id,e)),r.forEach(e=>{i.has(e)||i.set(e,{id:e})});let a=Array.from(i.values());return a.length===0&&a.push({id:`main`,isDefault:!0}),a.sort((e,t)=>{if(e.isDefault&&!t.isDefault)return-1;if(!e.isDefault&&t.isDefault)return 1;let n=e.name?.trim()?e.name:e.id,r=t.name?.trim()?t.name:t.id;return n.localeCompare(r)}),a}function C(e,t){return e===h?h:e&&t.some(t=>t.id===e)?e:h}function w(e){let t=e.execApprovalsForm??e.execApprovalsSnapshot?.file??null,n=!!t,r=b(t),i=S(e.configForm,t),a=j(e.nodes),o=e.execApprovalsTarget,s=o===`node`&&e.execApprovalsTargetNodeId?e.execApprovalsTargetNodeId:null;o===`node`&&s&&!a.some(e=>e.id===s)&&(s=null);let c=C(e.execApprovalsSelectedAgent,i),l=c===h?null:(t?.agents??{})[c]??null,u=Array.isArray(l?.allowlist)?l.allowlist??[]:[];return{ready:n,disabled:e.execApprovalsSaving||e.execApprovalsLoading,dirty:e.execApprovalsDirty,loading:e.execApprovalsLoading,saving:e.execApprovalsSaving,form:t,defaults:r,selectedScope:c,selectedAgent:l,agents:i,allowlist:u,target:o,targetNodeId:s,targetNodes:a,onSelectScope:e.onExecApprovalsSelectAgent,onSelectTarget:e.onExecApprovalsTargetChange,onPatch:e.onExecApprovalsPatch,onRemove:e.onExecApprovalsRemove,onLoad:e.onLoadExecApprovals,onSave:e.onSaveExecApprovals}}function T(e){let t=e.ready,n=e.target!==`node`||!!e.targetNodeId;return o`
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
          ?disabled=${e.disabled||!e.dirty||!n}
          @click=${e.onSave}
        >
          ${e.saving?`Saving…`:`Save`}
        </button>
      </div>

      ${E(e)}
      ${t?o`
            ${D(e)} ${O(e)}
            ${e.selectedScope===h?a:k(e)}
          `:o`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load exec approvals to edit allowlists.</div>
            <button class="btn" ?disabled=${e.loading||!n} @click=${e.onLoad}>
              ${e.loading?i(`common.loading`):i(`common.loadApprovals`)}
            </button>
          </div>`}
    </section>
  `}function E(e){let t=e.targetNodes.length>0,n=e.targetNodeId??``;return o`
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
              ?disabled=${e.disabled}
              @change=${t=>{if(t.target.value===`node`){let t=e.targetNodes[0]?.id??null;e.onSelectTarget(`node`,n||t)}else e.onSelectTarget(`gateway`,null)}}
            >
              <option value="gateway" ?selected=${e.target===`gateway`}>Gateway</option>
              <option value="node" ?selected=${e.target===`node`}>Node</option>
            </select>
          </label>
          ${e.target===`node`?o`
                <label class="field">
                  <span>Node</span>
                  <select
                    ?disabled=${e.disabled||!t}
                    @change=${t=>{let n=t.target.value.trim();e.onSelectTarget(`node`,n||null)}}
                  >
                    <option value="" ?selected=${n===``}>Select node</option>
                    ${e.targetNodes.map(e=>o`<option value=${e.id} ?selected=${n===e.id}>
                          ${e.label}
                        </option>`)}
                  </select>
                </label>
              `:a}
        </div>
      </div>
      ${e.target===`node`&&!t?o` <div class="muted">No nodes advertise exec approvals yet.</div> `:a}
    </div>
  `}function D(e){return o`
    <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
      <span class="label">Scope</span>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <button
          class="btn btn--sm ${e.selectedScope===h?`active`:``}"
          @click=${()=>e.onSelectScope(h)}
        >
          Defaults
        </button>
        ${e.agents.map(t=>{let n=t.name?.trim()?`${t.name} (${t.id})`:t.id;return o`
            <button
              class="btn btn--sm ${e.selectedScope===t.id?`active`:``}"
              @click=${()=>e.onSelectScope(t.id)}
            >
              ${n}
            </button>
          `})}
      </div>
    </div>
  `}function O(e){let t=e.selectedScope===h,n=e.defaults,r=e.selectedAgent??{},i=t?[`defaults`]:[`agents`,e.selectedScope],s=typeof r.security==`string`?r.security:void 0,c=typeof r.ask==`string`?r.ask:void 0,l=typeof r.askFallback==`string`?r.askFallback:void 0,u=t?n.security:s??`__default__`,d=t?n.ask:c??`__default__`,f=t?n.askFallback:l??`__default__`,p=typeof r.autoAllowSkills==`boolean`?r.autoAllowSkills:void 0,m=p??n.autoAllowSkills,v=p==null;return o`
    <div class="list" style="margin-top: 16px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Security</div>
          <div class="list-sub">
            ${t?`Default security mode.`:`Default: ${n.security}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${e.disabled}
              @change=${n=>{let r=n.target.value;!t&&r===`__default__`?e.onRemove([...i,`security`]):e.onPatch([...i,`security`],r)}}
            >
              ${t?a:o`<option value="__default__" ?selected=${u===`__default__`}>
                    Use default (${n.security})
                  </option>`}
              ${g.map(e=>o`<option value=${e.value} ?selected=${u===e.value}>
                    ${e.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask</div>
          <div class="list-sub">
            ${t?`Default prompt policy.`:`Default: ${n.ask}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${e.disabled}
              @change=${n=>{let r=n.target.value;!t&&r===`__default__`?e.onRemove([...i,`ask`]):e.onPatch([...i,`ask`],r)}}
            >
              ${t?a:o`<option value="__default__" ?selected=${d===`__default__`}>
                    Use default (${n.ask})
                  </option>`}
              ${_.map(e=>o`<option value=${e.value} ?selected=${d===e.value}>
                    ${e.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask fallback</div>
          <div class="list-sub">
            ${t?`Applied when the UI prompt is unavailable.`:`Default: ${n.askFallback}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Fallback</span>
            <select
              ?disabled=${e.disabled}
              @change=${n=>{let r=n.target.value;!t&&r===`__default__`?e.onRemove([...i,`askFallback`]):e.onPatch([...i,`askFallback`],r)}}
            >
              ${t?a:o`<option value="__default__" ?selected=${f===`__default__`}>
                    Use default (${n.askFallback})
                  </option>`}
              ${g.map(e=>o`<option value=${e.value} ?selected=${f===e.value}>
                    ${e.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Auto-allow skill CLIs</div>
          <div class="list-sub">
            ${t?`Allow skill executables listed by the Gateway.`:v?`Using default (${n.autoAllowSkills?`on`:`off`}).`:`Override (${m?`on`:`off`}).`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Enabled</span>
            <input
              type="checkbox"
              ?disabled=${e.disabled}
              .checked=${m}
              @change=${t=>{let n=t.target;e.onPatch([...i,`autoAllowSkills`],n.checked)}}
            />
          </label>
          ${!t&&!v?o`<button
                class="btn btn--sm"
                ?disabled=${e.disabled}
                @click=${()=>e.onRemove([...i,`autoAllowSkills`])}
              >
                Use default
              </button>`:a}
        </div>
      </div>
    </div>
  `}function k(e){let t=[`agents`,e.selectedScope,`allowlist`],n=e.allowlist;return o`
    <div class="row" style="margin-top: 18px; justify-content: space-between;">
      <div>
        <div class="card-title">Allowlist</div>
        <div class="card-sub">Case-insensitive glob patterns.</div>
      </div>
      <button
        class="btn btn--sm"
        ?disabled=${e.disabled}
        @click=${()=>{let r=[...n,{pattern:``}];e.onPatch(t,r)}}
      >
        Add pattern
      </button>
    </div>
    <div class="list" style="margin-top: 12px;">
      ${n.length===0?o` <div class="muted">No allowlist entries yet.</div> `:n.map((t,n)=>A(e,t,n))}
    </div>
  `}function A(e,n,r){let i=n.lastUsedAt?t(n.lastUsedAt):`never`,c=n.lastUsedCommand?s(n.lastUsedCommand,120):null,l=n.lastResolvedPath?s(n.lastResolvedPath,120):null;return o`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${n.pattern?.trim()?n.pattern:`New pattern`}</div>
        <div class="list-sub">Last used: ${i}</div>
        ${c?o`<div class="list-sub mono">${c}</div>`:a}
        ${l?o`<div class="list-sub mono">${l}</div>`:a}
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Pattern</span>
          <input
            type="text"
            .value=${n.pattern??``}
            ?disabled=${e.disabled}
            @input=${t=>{let n=t.target;e.onPatch([`agents`,e.selectedScope,`allowlist`,r,`pattern`],n.value)}}
          />
        </label>
        <button
          class="btn btn--sm danger"
          ?disabled=${e.disabled}
          @click=${()=>{if(e.allowlist.length<=1){e.onRemove([`agents`,e.selectedScope,`allowlist`]);return}e.onRemove([`agents`,e.selectedScope,`allowlist`,r])}}
        >
          Remove
        </button>
      </div>
    </div>
  `}function j(e){return m(e,[`system.execApprovals.get`,`system.execApprovals.set`])}function M(e){let t=B(e);return o`
    ${T(w(e))} ${V(t)} ${N(e)}
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Nodes</div>
          <div class="card-sub">Paired devices and live links.</div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?i(`common.loading`):i(`common.refresh`)}
        </button>
      </div>
      <div class="list" style="margin-top: 16px;">
        ${e.nodes.length===0?o` <div class="muted">No nodes found.</div> `:e.nodes.map(e=>G(e))}
      </div>
    </section>
  `}function N(t){let n=t.devicesList??{pending:[],paired:[]},r=Array.isArray(n.pending)?n.pending:[],s=Array.isArray(n.paired)?n.paired:[],c=new Map(s.map(t=>[e(t.deviceId),t]).filter(e=>!!e[0]));return o`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Devices</div>
          <div class="card-sub">Pairing requests + role tokens.</div>
        </div>
        <button class="btn" ?disabled=${t.devicesLoading} @click=${t.onDevicesRefresh}>
          ${t.devicesLoading?i(`common.loading`):i(`common.refresh`)}
        </button>
      </div>
      ${t.devicesError?o`<div class="callout danger" style="margin-top: 12px;">${t.devicesError}</div>`:a}
      <div class="list" style="margin-top: 16px;">
        ${r.length>0?o`
              <div class="muted" style="margin-bottom: 8px;">Pending</div>
              ${r.map(e=>L(e,t,P(c,e)))}
            `:a}
        ${s.length>0?o`
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">Paired</div>
              ${s.map(e=>R(e,t))}
            `:a}
        ${r.length===0&&s.length===0?o` <div class="muted">No paired devices.</div> `:a}
      </div>
    </section>
  `}function P(t,n){let r=e(n.deviceId);if(!r)return;let i=t.get(r);if(!i)return;let a=e(n.publicKey),o=e(i.publicKey);if(!(a&&o&&a!==o))return i}function F(e){return e?`roles: ${n(e.roles)} · scopes: ${n(e.scopes)}`:`none`}function I(e){switch(e){case`scope-upgrade`:return`scope upgrade requires approval`;case`role-upgrade`:return`role upgrade requires approval`;case`re-approval`:return`reconnect details changed; approval required`;case`new-pairing`:return`new device pairing request`}throw Error(`unsupported pending approval kind`)}function L(n,r,s){let c=e(n.displayName)||n.deviceId,l=typeof n.ts==`number`?t(n.ts):i(`common.na`),u=f(n,s),d=n.isRepair?` · repair`:``,p=n.remoteIp?` · ${n.remoteIp}`:``;return o`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${c}</div>
        <div class="list-sub">${n.deviceId}${p}</div>
        <div class="muted" style="margin-top: 6px;">
          ${I(u.kind)} · requested ${l}${d}
        </div>
        <div class="muted" style="margin-top: 6px;">
          requested: ${F(u.requested)}
        </div>
        ${u.approved?o`
              <div class="muted" style="margin-top: 6px;">
                approved now: ${F(u.approved)}
              </div>
            `:a}
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm primary" @click=${()=>r.onDeviceApprove(n.requestId)}>
            Approve
          </button>
          <button class="btn btn--sm" @click=${()=>r.onDeviceReject(n.requestId)}>
            Reject
          </button>
        </div>
      </div>
    </div>
  `}function R(t,r){let i=e(t.displayName)||t.deviceId,a=t.remoteIp?` · ${t.remoteIp}`:``,s=`roles: ${n(t.roles)}`,c=`scopes: ${n(t.scopes)}`,l=Array.isArray(t.tokens)?t.tokens:[];return o`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${i}</div>
        <div class="list-sub">${t.deviceId}${a}</div>
        <div class="muted" style="margin-top: 6px;">${s} · ${c}</div>
        ${l.length===0?o` <div class="muted" style="margin-top: 6px">Tokens: none</div> `:o`
              <div class="muted" style="margin-top: 10px;">Tokens</div>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
                ${l.map(e=>z(t.deviceId,e,r))}
              </div>
            `}
      </div>
    </div>
  `}function z(e,r,i){let s=r.revokedAtMs?`revoked`:`active`,c=`scopes: ${n(r.scopes)}`,l=t(r.rotatedAtMs??r.createdAtMs??r.lastUsedAtMs??null);return o`
    <div class="row" style="justify-content: space-between; gap: 8px;">
      <div class="list-sub">${r.role} · ${s} · ${c} · ${l}</div>
      <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
        <button
          class="btn btn--sm"
          @click=${()=>i.onDeviceRotate(e,r.role,r.scopes)}
        >
          Rotate
        </button>
        ${r.revokedAtMs?a:o`
              <button
                class="btn btn--sm danger"
                @click=${()=>i.onDeviceRevoke(e,r.role)}
              >
                Revoke
              </button>
            `}
      </div>
    </div>
  `}function B(e){let t=e.configForm,n=U(e.nodes),{defaultBinding:r,agents:i}=W(t);return{ready:!!t,disabled:e.configSaving||e.configFormMode===`raw`,configDirty:e.configDirty,configLoading:e.configLoading,configSaving:e.configSaving,defaultBinding:r,agents:i,nodes:n,onBindDefault:e.onBindDefault,onBindAgent:e.onBindAgent,onSave:e.onSaveBindings,onLoadConfig:e.onLoadConfig,formMode:e.configFormMode}}function V(e){let t=e.nodes.length>0,n=e.defaultBinding??``;return o`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">${i(`nodes.binding.execNodeBinding`)}</div>
          <div class="card-sub">${i(`nodes.binding.execNodeBindingSubtitle`)}</div>
        </div>
        <button
          class="btn"
          ?disabled=${e.disabled||!e.configDirty}
          @click=${e.onSave}
        >
          ${e.configSaving?i(`common.saving`):i(`common.save`)}
        </button>
      </div>

      ${e.formMode===`raw`?o`
            <div class="callout warn" style="margin-top: 12px">
              ${i(`nodes.binding.formModeHint`)}
            </div>
          `:a}
      ${e.ready?o`
            <div class="list" style="margin-top: 16px;">
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">${i(`nodes.binding.defaultBinding`)}</div>
                  <div class="list-sub">${i(`nodes.binding.defaultBindingHint`)}</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>${i(`nodes.binding.node`)}</span>
                    <select
                      ?disabled=${e.disabled||!t}
                      @change=${t=>{let n=t.target.value.trim();e.onBindDefault(n||null)}}
                    >
                      <option value="" ?selected=${n===``}>Any node</option>
                      ${e.nodes.map(e=>o`<option value=${e.id} ?selected=${n===e.id}>
                            ${e.label}
                          </option>`)}
                    </select>
                  </label>
                  ${t?a:o` <div class="muted">No nodes with system.run available.</div> `}
                </div>
              </div>

              ${e.agents.length===0?o` <div class="muted">No agents found.</div> `:e.agents.map(t=>H(t,e))}
            </div>
          `:o`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">${i(`nodes.binding.loadConfigHint`)}</div>
            <button class="btn" ?disabled=${e.configLoading} @click=${e.onLoadConfig}>
              ${e.configLoading?i(`common.loading`):i(`common.loadConfig`)}
            </button>
          </div>`}
    </section>
  `}function H(e,t){let n=e.binding??`__default__`,r=e.name?.trim()?`${e.name} (${e.id})`:e.id,i=t.nodes.length>0;return o`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${r}</div>
        <div class="list-sub">
          ${e.isDefault?`default agent`:`agent`} ·
          ${n===`__default__`?`uses default (${t.defaultBinding??`any`})`:`override: ${e.binding}`}
        </div>
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Binding</span>
          <select
            ?disabled=${t.disabled||!i}
            @change=${n=>{let r=n.target.value.trim();t.onBindAgent(e.index,r===`__default__`?null:r)}}
          >
            <option value="__default__" ?selected=${n===`__default__`}>
              Use default
            </option>
            ${t.nodes.map(e=>o`<option value=${e.id} ?selected=${n===e.id}>
                  ${e.label}
                </option>`)}
          </select>
        </label>
      </div>
    </div>
  `}function U(e){return m(e,[`system.run`])}function W(e){let t={id:`main`,name:void 0,index:0,isDefault:!0,binding:null};if(!e||typeof e!=`object`)return{defaultBinding:null,agents:[t]};let n=(e.tools??{}).exec??{},r=typeof n.node==`string`&&n.node.trim()?n.node.trim():null,i=e.agents??{};if(!Array.isArray(i.list)||i.list.length===0)return{defaultBinding:r,agents:[t]};let a=p(e).map(e=>{let t=(e.record.tools??{}).exec??{},n=typeof t.node==`string`&&t.node.trim()?t.node.trim():null;return{id:e.id,name:e.name,index:e.index,isDefault:e.isDefault,binding:n}});return a.length===0&&a.push(t),{defaultBinding:r,agents:a}}function G(e){let t=!!e.connected,n=!!e.paired,r=typeof e.displayName==`string`&&e.displayName.trim()||(typeof e.nodeId==`string`?e.nodeId:`unknown`),i=Array.isArray(e.caps)?e.caps:[],a=Array.isArray(e.commands)?e.commands:[];return o`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${r}</div>
        <div class="list-sub">
          ${typeof e.nodeId==`string`?e.nodeId:``}
          ${typeof e.remoteIp==`string`?` · ${e.remoteIp}`:``}
          ${typeof e.version==`string`?` · ${e.version}`:``}
        </div>
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${n?`paired`:`unpaired`}</span>
          <span class="chip ${t?`chip-ok`:`chip-warn`}">
            ${t?`connected`:`offline`}
          </span>
          ${i.slice(0,12).map(e=>o`<span class="chip">${String(e)}</span>`)}
          ${a.slice(0,8).map(e=>o`<span class="chip">${String(e)}</span>`)}
        </div>
      </div>
    </div>
  `}export{M as renderNodes};
//# sourceMappingURL=nodes-BXYC5-Xp.js.map