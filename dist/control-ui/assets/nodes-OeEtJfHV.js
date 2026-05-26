import{E as e,Q as t,T as n,et as r,it as i,k as a,rt as o,tt as s}from"./index-BtIuF4zW.js";function c(...e){let t=new Set;for(let n of e){if(!n)continue;if(Array.isArray(n)){for(let e of n){let n=e.trim();n&&t.add(n)}continue}let e=n.trim();e&&t.add(e)}return[...t].toSorted()}function l(e,t){let n=new Set(e);return t.every(e=>n.has(e))}function u(e){return{roles:c(e.roles,e.role),scopes:t(e.scopes)}}function d(e){let n=c(e.roles,e.role),r=Array.isArray(e.tokens)?e.tokens:e.tokens?Object.values(e.tokens):void 0;return{roles:r===void 0?n:c(r.filter(e=>!e.revokedAtMs).flatMap(e=>e.role??[])).filter(e=>n.includes(e)),scopes:t(e.scopes)}}function f(e,t){let n=u(e),r=t?d(t):null;return r?l(r.roles,n.roles)?l(r.scopes,n.scopes)?{kind:`re-approval`,requested:n,approved:r}:{kind:`scope-upgrade`,requested:n,approved:r}:{kind:`role-upgrade`,requested:n,approved:r}:{kind:`new-pairing`,requested:n,approved:null}}function p(e){let t=e?.agents??{},n=Array.isArray(t.list)?t.list:[],i=[];return n.forEach((e,t)=>{if(!e||typeof e!=`object`)return;let n=e,a=r(n.id)??``;if(!a)return;let o=r(n.name),s=n.default===!0;i.push({id:a,name:o,isDefault:s,index:t,record:n})}),i}function m(e,t){let n=new Set(t),i=[];for(let t of e){if(!(Array.isArray(t.commands)?t.commands:[]).some(e=>n.has(String(e))))continue;let e=r(t.nodeId)??``;if(!e)continue;let a=r(t.displayName)??e;i.push({id:e,label:a===e?e:`${a} · ${e}`})}return i.sort((e,t)=>e.label.localeCompare(t.label)),i}var h=`__defaults__`,g=[{value:`deny`,label:`Deny`},{value:`allowlist`,label:`Allowlist`},{value:`full`,label:`Full`}],_=[{value:`off`,label:`Off`},{value:`on-miss`,label:`On miss`},{value:`always`,label:`Always`}];function v(e){return e===`allowlist`||e===`full`||e===`deny`?e:`deny`}function y(e){return e===`always`||e===`off`||e===`on-miss`?e:`on-miss`}function b(e){let t=e?.defaults??{};return{security:v(t.security),ask:y(t.ask),askFallback:v(t.askFallback??`deny`),autoAllowSkills:t.autoAllowSkills??!1}}function x(e){return p(e).map(e=>({id:e.id,name:e.name,isDefault:e.isDefault}))}function S(e,t){let n=x(e),r=Object.keys(t?.agents??{}),i=new Map;n.forEach(e=>i.set(e.id,e)),r.forEach(e=>{i.has(e)||i.set(e,{id:e})});let a=Array.from(i.values());return a.length===0&&a.push({id:`main`,isDefault:!0}),a.sort((e,t)=>{if(e.isDefault&&!t.isDefault)return-1;if(!e.isDefault&&t.isDefault)return 1;let n=e.name?.trim()?e.name:e.id,r=t.name?.trim()?t.name:t.id;return n.localeCompare(r)}),a}function C(e,t){return e===h?h:e&&t.some(t=>t.id===e)?e:h}function w(e){let t=e.execApprovalsForm??e.execApprovalsSnapshot?.file??null,n=!!t,r=b(t),i=S(e.configForm,t),a=j(e.nodes),o=e.execApprovalsTarget,s=o===`node`&&e.execApprovalsTargetNodeId?e.execApprovalsTargetNodeId:null;o===`node`&&s&&!a.some(e=>e.id===s)&&(s=null);let c=C(e.execApprovalsSelectedAgent,i),l=c===h?null:(t?.agents??{})[c]??null,u=Array.isArray(l?.allowlist)?l.allowlist??[]:[];return{ready:n,disabled:e.execApprovalsSaving||e.execApprovalsLoading,dirty:e.execApprovalsDirty,loading:e.execApprovalsLoading,saving:e.execApprovalsSaving,form:t,defaults:r,selectedScope:c,selectedAgent:l,agents:i,allowlist:u,target:o,targetNodeId:s,targetNodes:a,onSelectScope:e.onExecApprovalsSelectAgent,onSelectTarget:e.onExecApprovalsTargetChange,onPatch:e.onExecApprovalsPatch,onRemove:e.onExecApprovalsRemove,onLoad:e.onLoadExecApprovals,onSave:e.onSaveExecApprovals}}function T(e){let t=e.ready,n=e.target!==`node`||!!e.targetNodeId;return i`
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
      ${t?i`
            ${D(e)} ${O(e)}
            ${e.selectedScope===h?o:k(e)}
          `:i`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load exec approvals to edit allowlists.</div>
            <button class="btn" ?disabled=${e.loading||!n} @click=${e.onLoad}>
              ${e.loading?s(`common.loading`):s(`common.loadApprovals`)}
            </button>
          </div>`}
    </section>
  `}function E(e){let t=e.targetNodes.length>0,n=e.targetNodeId??``;return i`
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
          ${e.target===`node`?i`
                <label class="field">
                  <span>Node</span>
                  <select
                    ?disabled=${e.disabled||!t}
                    @change=${t=>{let n=t.target.value.trim();e.onSelectTarget(`node`,n||null)}}
                  >
                    <option value="" ?selected=${n===``}>Select node</option>
                    ${e.targetNodes.map(e=>i`<option value=${e.id} ?selected=${n===e.id}>
                          ${e.label}
                        </option>`)}
                  </select>
                </label>
              `:o}
        </div>
      </div>
      ${e.target===`node`&&!t?i` <div class="muted">No nodes advertise exec approvals yet.</div> `:o}
    </div>
  `}function D(e){return i`
    <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
      <span class="label">Scope</span>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <button
          class="btn btn--sm ${e.selectedScope===h?`active`:``}"
          @click=${()=>e.onSelectScope(h)}
        >
          Defaults
        </button>
        ${e.agents.map(t=>{let n=t.name?.trim()?`${t.name} (${t.id})`:t.id;return i`
            <button
              class="btn btn--sm ${e.selectedScope===t.id?`active`:``}"
              @click=${()=>e.onSelectScope(t.id)}
            >
              ${n}
            </button>
          `})}
      </div>
    </div>
  `}function O(e){let t=e.selectedScope===h,n=e.defaults,r=e.selectedAgent??{},a=t?[`defaults`]:[`agents`,e.selectedScope],s=typeof r.security==`string`?r.security:void 0,c=typeof r.ask==`string`?r.ask:void 0,l=typeof r.askFallback==`string`?r.askFallback:void 0,u=t?n.security:s??`__default__`,d=t?n.ask:c??`__default__`,f=t?n.askFallback:l??`__default__`,p=typeof r.autoAllowSkills==`boolean`?r.autoAllowSkills:void 0,m=p??n.autoAllowSkills,v=p==null;return i`
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
              @change=${n=>{let r=n.target.value;!t&&r===`__default__`?e.onRemove([...a,`security`]):e.onPatch([...a,`security`],r)}}
            >
              ${t?o:i`<option value="__default__" ?selected=${u===`__default__`}>
                    Use default (${n.security})
                  </option>`}
              ${g.map(e=>i`<option value=${e.value} ?selected=${u===e.value}>
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
              @change=${n=>{let r=n.target.value;!t&&r===`__default__`?e.onRemove([...a,`ask`]):e.onPatch([...a,`ask`],r)}}
            >
              ${t?o:i`<option value="__default__" ?selected=${d===`__default__`}>
                    Use default (${n.ask})
                  </option>`}
              ${_.map(e=>i`<option value=${e.value} ?selected=${d===e.value}>
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
              @change=${n=>{let r=n.target.value;!t&&r===`__default__`?e.onRemove([...a,`askFallback`]):e.onPatch([...a,`askFallback`],r)}}
            >
              ${t?o:i`<option value="__default__" ?selected=${f===`__default__`}>
                    Use default (${n.askFallback})
                  </option>`}
              ${g.map(e=>i`<option value=${e.value} ?selected=${f===e.value}>
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
              @change=${t=>{let n=t.target;e.onPatch([...a,`autoAllowSkills`],n.checked)}}
            />
          </label>
          ${!t&&!v?i`<button
                class="btn btn--sm"
                ?disabled=${e.disabled}
                @click=${()=>e.onRemove([...a,`autoAllowSkills`])}
              >
                Use default
              </button>`:o}
        </div>
      </div>
    </div>
  `}function k(e){let t=[`agents`,e.selectedScope,`allowlist`],n=e.allowlist;return i`
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
      ${n.length===0?i` <div class="muted">No allowlist entries yet.</div> `:n.map((t,n)=>A(e,t,n))}
    </div>
  `}function A(e,t,r){let s=t.lastUsedAt?a(t.lastUsedAt):`never`,c=t.lastUsedCommand?n(t.lastUsedCommand,120):null,l=t.lastResolvedPath?n(t.lastResolvedPath,120):null;return i`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${t.pattern?.trim()?t.pattern:`New pattern`}</div>
        <div class="list-sub">Last used: ${s}</div>
        ${c?i`<div class="list-sub mono">${c}</div>`:o}
        ${l?i`<div class="list-sub mono">${l}</div>`:o}
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Pattern</span>
          <input
            type="text"
            .value=${t.pattern??``}
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
  `}function j(e){return m(e,[`system.execApprovals.get`,`system.execApprovals.set`])}function M(e){let t=B(e);return i`
    ${T(w(e))} ${V(t)} ${N(e)}
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Nodes</div>
          <div class="card-sub">Paired devices and live links.</div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?s(`common.loading`):s(`common.refresh`)}
        </button>
      </div>
      <div class="list" style="margin-top: 16px;">
        ${e.nodes.length===0?i` <div class="muted">No nodes found.</div> `:e.nodes.map(e=>G(e))}
      </div>
    </section>
  `}function N(e){let t=e.devicesList??{pending:[],paired:[]},n=Array.isArray(t.pending)?t.pending:[],a=Array.isArray(t.paired)?t.paired:[],c=new Map(a.map(e=>[r(e.deviceId),e]).filter(e=>!!e[0]));return i`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Devices</div>
          <div class="card-sub">Pairing requests + role tokens.</div>
        </div>
        <button class="btn" ?disabled=${e.devicesLoading} @click=${e.onDevicesRefresh}>
          ${e.devicesLoading?s(`common.loading`):s(`common.refresh`)}
        </button>
      </div>
      ${e.devicesError?i`<div class="callout danger" style="margin-top: 12px;">${e.devicesError}</div>`:o}
      <div class="list" style="margin-top: 16px;">
        ${n.length>0?i`
              <div class="muted" style="margin-bottom: 8px;">Pending</div>
              ${n.map(t=>L(t,e,P(c,t)))}
            `:o}
        ${a.length>0?i`
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">Paired</div>
              ${a.map(t=>R(t,e))}
            `:o}
        ${n.length===0&&a.length===0?i` <div class="muted">No paired devices.</div> `:o}
      </div>
    </section>
  `}function P(e,t){let n=r(t.deviceId);if(!n)return;let i=e.get(n);if(!i)return;let a=r(t.publicKey),o=r(i.publicKey);if(!(a&&o&&a!==o))return i}function F(t){return t?`roles: ${e(t.roles)} · scopes: ${e(t.scopes)}`:`none`}function I(e){switch(e){case`scope-upgrade`:return`scope upgrade requires approval`;case`role-upgrade`:return`role upgrade requires approval`;case`re-approval`:return`reconnect details changed; approval required`;case`new-pairing`:return`new device pairing request`}throw Error(`unsupported pending approval kind`)}function L(e,t,n){let c=r(e.displayName)||e.deviceId,l=typeof e.ts==`number`?a(e.ts):s(`common.na`),u=f(e,n),d=e.isRepair?` · repair`:``,p=e.remoteIp?` · ${e.remoteIp}`:``;return i`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${c}</div>
        <div class="list-sub">${e.deviceId}${p}</div>
        <div class="muted" style="margin-top: 6px;">
          ${I(u.kind)} · requested ${l}${d}
        </div>
        <div class="muted" style="margin-top: 6px;">
          requested: ${F(u.requested)}
        </div>
        ${u.approved?i`
              <div class="muted" style="margin-top: 6px;">
                approved now: ${F(u.approved)}
              </div>
            `:o}
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm primary" @click=${()=>t.onDeviceApprove(e.requestId)}>
            Approve
          </button>
          <button class="btn btn--sm" @click=${()=>t.onDeviceReject(e.requestId)}>
            Reject
          </button>
        </div>
      </div>
    </div>
  `}function R(t,n){let a=r(t.displayName)||t.deviceId,o=t.remoteIp?` · ${t.remoteIp}`:``,s=`roles: ${e(t.roles)}`,c=`scopes: ${e(t.scopes)}`,l=Array.isArray(t.tokens)?t.tokens:[];return i`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${a}</div>
        <div class="list-sub">${t.deviceId}${o}</div>
        <div class="muted" style="margin-top: 6px;">${s} · ${c}</div>
        ${l.length===0?i` <div class="muted" style="margin-top: 6px">Tokens: none</div> `:i`
              <div class="muted" style="margin-top: 10px;">Tokens</div>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
                ${l.map(e=>z(t.deviceId,e,n))}
              </div>
            `}
      </div>
    </div>
  `}function z(t,n,r){let s=n.revokedAtMs?`revoked`:`active`,c=`scopes: ${e(n.scopes)}`,l=a(n.rotatedAtMs??n.createdAtMs??n.lastUsedAtMs??null);return i`
    <div class="row" style="justify-content: space-between; gap: 8px;">
      <div class="list-sub">${n.role} · ${s} · ${c} · ${l}</div>
      <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
        <button
          class="btn btn--sm"
          @click=${()=>r.onDeviceRotate(t,n.role,n.scopes)}
        >
          Rotate
        </button>
        ${n.revokedAtMs?o:i`
              <button
                class="btn btn--sm danger"
                @click=${()=>r.onDeviceRevoke(t,n.role)}
              >
                Revoke
              </button>
            `}
      </div>
    </div>
  `}function B(e){let t=e.configForm,n=U(e.nodes),{defaultBinding:r,agents:i}=W(t);return{ready:!!t,disabled:e.configSaving||e.configFormMode===`raw`,configDirty:e.configDirty,configLoading:e.configLoading,configSaving:e.configSaving,defaultBinding:r,agents:i,nodes:n,onBindDefault:e.onBindDefault,onBindAgent:e.onBindAgent,onSave:e.onSaveBindings,onLoadConfig:e.onLoadConfig,formMode:e.configFormMode}}function V(e){let t=e.nodes.length>0,n=e.defaultBinding??``;return i`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">${s(`nodes.binding.execNodeBinding`)}</div>
          <div class="card-sub">${s(`nodes.binding.execNodeBindingSubtitle`)}</div>
        </div>
        <button
          class="btn"
          ?disabled=${e.disabled||!e.configDirty}
          @click=${e.onSave}
        >
          ${e.configSaving?s(`common.saving`):s(`common.save`)}
        </button>
      </div>

      ${e.formMode===`raw`?i`
            <div class="callout warn" style="margin-top: 12px">
              ${s(`nodes.binding.formModeHint`)}
            </div>
          `:o}
      ${e.ready?i`
            <div class="list" style="margin-top: 16px;">
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">${s(`nodes.binding.defaultBinding`)}</div>
                  <div class="list-sub">${s(`nodes.binding.defaultBindingHint`)}</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>${s(`nodes.binding.node`)}</span>
                    <select
                      ?disabled=${e.disabled||!t}
                      @change=${t=>{let n=t.target.value.trim();e.onBindDefault(n||null)}}
                    >
                      <option value="" ?selected=${n===``}>Any node</option>
                      ${e.nodes.map(e=>i`<option value=${e.id} ?selected=${n===e.id}>
                            ${e.label}
                          </option>`)}
                    </select>
                  </label>
                  ${t?o:i` <div class="muted">No nodes with system.run available.</div> `}
                </div>
              </div>

              ${e.agents.length===0?i` <div class="muted">No agents found.</div> `:e.agents.map(t=>H(t,e))}
            </div>
          `:i`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">${s(`nodes.binding.loadConfigHint`)}</div>
            <button class="btn" ?disabled=${e.configLoading} @click=${e.onLoadConfig}>
              ${e.configLoading?s(`common.loading`):s(`common.loadConfig`)}
            </button>
          </div>`}
    </section>
  `}function H(e,t){let n=e.binding??`__default__`,r=e.name?.trim()?`${e.name} (${e.id})`:e.id,a=t.nodes.length>0;return i`
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
            ?disabled=${t.disabled||!a}
            @change=${n=>{let r=n.target.value.trim();t.onBindAgent(e.index,r===`__default__`?null:r)}}
          >
            <option value="__default__" ?selected=${n===`__default__`}>
              Use default
            </option>
            ${t.nodes.map(e=>i`<option value=${e.id} ?selected=${n===e.id}>
                  ${e.label}
                </option>`)}
          </select>
        </label>
      </div>
    </div>
  `}function U(e){return m(e,[`system.run`])}function W(e){let t={id:`main`,name:void 0,index:0,isDefault:!0,binding:null};if(!e||typeof e!=`object`)return{defaultBinding:null,agents:[t]};let n=(e.tools??{}).exec??{},r=typeof n.node==`string`&&n.node.trim()?n.node.trim():null,i=e.agents??{};if(!Array.isArray(i.list)||i.list.length===0)return{defaultBinding:r,agents:[t]};let a=p(e).map(e=>{let t=(e.record.tools??{}).exec??{},n=typeof t.node==`string`&&t.node.trim()?t.node.trim():null;return{id:e.id,name:e.name,index:e.index,isDefault:e.isDefault,binding:n}});return a.length===0&&a.push(t),{defaultBinding:r,agents:a}}function G(e){let t=!!e.connected,n=!!e.paired,r=typeof e.displayName==`string`&&e.displayName.trim()||(typeof e.nodeId==`string`?e.nodeId:`unknown`),a=Array.isArray(e.caps)?e.caps:[],o=Array.isArray(e.commands)?e.commands:[];return i`
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
          ${a.slice(0,12).map(e=>i`<span class="chip">${String(e)}</span>`)}
          ${o.slice(0,8).map(e=>i`<span class="chip">${String(e)}</span>`)}
        </div>
      </div>
    </div>
  `}export{M as renderNodes};
//# sourceMappingURL=nodes-OeEtJfHV.js.map