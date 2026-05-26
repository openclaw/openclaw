import{A as e,X as t,Z as n,c as r,it as i,k as a,l as o,rt as s,tt as c}from"./index-BtIuF4zW.js";import{n as l,t as u}from"./channel-config-extras-B7kNiKH2.js";function d(e,t){let r=e;for(let e of t){if(!r)return null;let t=n(r);if(t===`object`){let t=r.properties??{};if(typeof e==`string`&&t[e]){r=t[e];continue}let n=r.additionalProperties;if(typeof e==`string`&&n&&typeof n==`object`){r=n;continue}return null}if(t===`array`){if(typeof e!=`number`)return null;r=(Array.isArray(r.items)?r.items[0]:r.items)??null;continue}return null}return r}function f(e,t){return l(e,t)??{}}var p=[`groupPolicy`,`streamMode`,`dmPolicy`];function m(e){let t=p.flatMap(t=>t in e?[[t,e[t]]]:[]);return t.length===0?null:i`
    <div class="status-list" style="margin-top: 12px;">
      ${t.map(([e,t])=>i`
          <div>
            <span class="label">${e}</span>
            <span>${u(t)}</span>
          </div>
        `)}
    </div>
  `}function h(e){let t=r(e.schema),n=t.schema;if(!n)return i` <div class="callout danger">Schema unavailable. Use Raw.</div> `;let a=d(n,[`channels`,e.channelId]);if(!a)return i` <div class="callout danger">Channel config schema unavailable.</div> `;let s=f(e.configValue??{},e.channelId);return i`
    <div class="config-form">
      ${o({schema:a,value:s,path:[`channels`,e.channelId],hints:e.uiHints,unsupported:new Set(t.unsupportedPaths),disabled:e.disabled,showLabel:!1,onPatch:e.onPatch})}
    </div>
    ${m(s)}
  `}function g(e){let{channelId:t,props:n}=e,r=n.configSaving||n.configSchemaLoading;return i`
    <div style="margin-top: 16px;">
      ${n.configSchemaLoading?i` <div class="muted">Loading config schema…</div> `:h({channelId:t,configValue:n.configForm,schema:n.configSchema,uiHints:n.configUiHints,disabled:r,onPatch:n.onConfigPatch})}
      <div class="row" style="margin-top: 12px;">
        <button
          class="btn primary"
          ?disabled=${r||!n.configFormDirty}
          @click=${()=>n.onConfigSave()}
        >
          ${n.configSaving?`Saving…`:`Save`}
        </button>
        <button class="btn" ?disabled=${r} @click=${()=>n.onConfigReload()}>
          ${c(`common.reload`)}
        </button>
      </div>
    </div>
  `}function _(e,t){return t.snapshot?.channels?.[e]}function v(e,t){let n=t.snapshot?.channelAccounts?.[e]??[],r=t.snapshot?.channelDefaultAccountId?.[e];return(r?n.find(e=>e.accountId===r):void 0)??n[0]??null}function y(e,t){let n=_(e,t),r=t.snapshot?.channelAccounts?.[e]??[],i=v(e,t);return{configured:typeof n?.configured==`boolean`?n.configured:typeof i?.configured==`boolean`?i.configured:null,running:typeof n?.running==`boolean`?n.running:null,connected:typeof n?.connected==`boolean`?n.connected:null,defaultAccount:i,hasAnyActiveAccount:r.some(e=>e.configured||e.running||e.connected),status:n}}function b(e,t){if(!t.snapshot)return!1;let n=y(e,t);return n.configured===!0||n.running===!0||n.connected===!0||n.hasAnyActiveAccount}function x(e,t){return y(e,t).configured}function S(e){return c(e==null?`common.na`:e?`common.yes`:`common.no`)}function C(e){return i`
    <div class="card">
      <div class="card-title">${e.title}</div>
      <div class="card-sub">${e.subtitle}</div>
      ${e.accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        ${e.statusRows.map(e=>i`
            <div>
              <span class="label">${e.label}</span>
              <span>${e.value}</span>
            </div>
          `)}
      </div>

      ${e.lastError?i`<div class="callout danger" style="margin-top: 12px;">${e.lastError}</div>`:s}
      ${e.secondaryCallout??s} ${e.extraContent??s}
      ${e.configSection} ${e.footer??s}
    </div>
  `}function w(e,t){return t?.[e]?.length??0}function T(e,t){let n=w(e,t);return n<2?s:i`<div class="account-count">Accounts (${n})</div>`}function E(e){let{props:t,discord:n,accountCountLabel:r}=e,o=x(`discord`,t);return C({title:`Discord`,subtitle:`Bot status and channel configuration.`,accountCountLabel:r,statusRows:[{label:c(`common.configured`),value:S(o)},{label:c(`common.running`),value:n?.running?c(`common.yes`):c(`common.no`)},{label:c(`common.lastStart`),value:n?.lastStartAt?a(n.lastStartAt):c(`common.na`)},{label:c(`common.lastProbe`),value:n?.lastProbeAt?a(n.lastProbeAt):c(`common.na`)}],lastError:n?.lastError,secondaryCallout:n?.probe?i`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?c(`common.probeOk`):c(`common.probeFailed`)} ·
          ${n.probe.status??``} ${n.probe.error??``}
        </div>`:s,configSection:g({channelId:`discord`,props:t}),footer:i`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>t.onRefresh(!0)}>${c(`common.probe`)}</button>
    </div>`})}function D(e){let{props:t,googleChat:n,accountCountLabel:r}=e,o=x(`googlechat`,t);return C({title:`Google Chat`,subtitle:`Chat API webhook status and channel configuration.`,accountCountLabel:r,statusRows:[{label:c(`common.configured`),value:S(o)},{label:c(`common.running`),value:n?n.running?c(`common.yes`):c(`common.no`):c(`common.na`)},{label:c(`common.credential`),value:n?.credentialSource??c(`common.na`)},{label:c(`common.audience`),value:n?.audienceType?`${n.audienceType}${n.audience?` · ${n.audience}`:``}`:c(`common.na`)},{label:c(`common.lastStart`),value:n?.lastStartAt?a(n.lastStartAt):c(`common.na`)},{label:c(`common.lastProbe`),value:n?.lastProbeAt?a(n.lastProbeAt):c(`common.na`)}],lastError:n?.lastError,secondaryCallout:n?.probe?i`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?c(`common.probeOk`):c(`common.probeFailed`)} ·
          ${n.probe.status??``} ${n.probe.error??``}
        </div>`:s,configSection:g({channelId:`googlechat`,props:t}),footer:i`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>t.onRefresh(!0)}>${c(`common.probe`)}</button>
    </div>`})}function O(e){let{props:t,imessage:n,accountCountLabel:r}=e,o=x(`imessage`,t);return C({title:`iMessage`,subtitle:`macOS bridge status and channel configuration.`,accountCountLabel:r,statusRows:[{label:c(`common.configured`),value:S(o)},{label:c(`common.running`),value:n?.running?c(`common.yes`):c(`common.no`)},{label:c(`common.lastStart`),value:n?.lastStartAt?a(n.lastStartAt):c(`common.na`)},{label:c(`common.lastProbe`),value:n?.lastProbeAt?a(n.lastProbeAt):c(`common.na`)}],lastError:n?.lastError,secondaryCallout:n?.probe?i`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?c(`common.probeOk`):c(`common.probeFailed`)} ·
          ${n.probe.error??``}
        </div>`:s,configSection:g({channelId:`imessage`,props:t}),footer:i`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>t.onRefresh(!0)}>${c(`common.probe`)}</button>
    </div>`})}function k(e){return e?e.length<=20?e:`${e.slice(0,8)}...${e.slice(-8)}`:c(`common.na`)}function A(e){let{props:n,nostr:r,nostrAccounts:o,accountCountLabel:l,profileFormState:u,profileFormCallbacks:d,onEditProfile:f}=e,p=o[0],m=r?.configured??p?.configured??!1,h=r?.running??p?.running??!1,_=r?.publicKey??p?.publicKey,v=r?.lastStartAt??p?.lastStartAt??null,y=r?.lastError??p?.lastError??null,b=o.length>1,x=u!=null,S=e=>{let t=e.publicKey,n=e.profile;return i`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${n?.displayName??n?.name??e.name??e.accountId}</div>
          <div class="account-card-id">${e.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">${c(`common.running`)}</span>
            <span>${e.running?c(`common.yes`):c(`common.no`)}</span>
          </div>
          <div>
            <span class="label">${c(`common.configured`)}</span>
            <span>${e.configured?c(`common.yes`):c(`common.no`)}</span>
          </div>
          <div>
            <span class="label">${c(`common.publicKey`)}</span>
            <span class="monospace" title="${t??``}">${k(t)}</span>
          </div>
          <div>
            <span class="label">${c(`common.lastInbound`)}</span>
            <span
              >${e.lastInboundAt?a(e.lastInboundAt):c(`common.na`)}</span
            >
          </div>
          ${e.lastError?i` <div class="account-card-error">${e.lastError}</div> `:s}
        </div>
      </div>
    `};return i`
    <div class="card">
      <div class="card-title">Nostr</div>
      <div class="card-sub">Decentralized DMs via Nostr relays (NIP-04).</div>
      ${l}
      ${b?i`
            <div class="account-card-list">
              ${o.map(e=>S(e))}
            </div>
          `:i`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">${c(`common.configured`)}</span>
                <span>${c(m?`common.yes`:`common.no`)}</span>
              </div>
              <div>
                <span class="label">${c(`common.running`)}</span>
                <span>${c(h?`common.yes`:`common.no`)}</span>
              </div>
              <div>
                <span class="label">${c(`common.publicKey`)}</span>
                <span class="monospace" title="${_??``}"
                  >${k(_)}</span
                >
              </div>
              <div>
                <span class="label">${c(`common.lastStart`)}</span>
                <span>
                  ${v?a(v):c(`common.na`)}
                </span>
              </div>
            </div>
          `}
      ${y?i`<div class="callout danger" style="margin-top: 12px;">${y}</div>`:s}
      ${(()=>{if(x&&d)return t({state:u,callbacks:d,accountId:o[0]?.accountId??`default`});let{name:e,displayName:n,about:a,picture:l,nip05:h}=p?.profile??r?.profile??{},g=e||n||a||l||h;return i`
      <div
        style="margin-top: 16px; padding: 12px; background: var(--bg-secondary); border-radius: var(--radius-md);"
      >
        <div
          style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;"
        >
          <div style="font-weight: 500;">${c(`channels.nostr.profile`)}</div>
          ${m?i`
                <button
                  class="btn btn--sm"
                  @click=${f}
                  style="font-size: 12px; padding: 4px 8px;"
                >
                  ${c(`channels.nostr.editProfile`)}
                </button>
              `:s}
        </div>
        ${g?i`
              <div class="status-list">
                ${l?i`
                      <div style="margin-bottom: 8px;">
                        <img
                          src=${l}
                          alt=${c(`channels.nostr.profilePicture`)}
                          style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);"
                          @error=${e=>{e.target.style.display=`none`}}
                        />
                      </div>
                    `:s}
                ${e?i`<div>
                      <span class="label">${c(`channels.nostr.name`)}</span><span>${e}</span>
                    </div>`:s}
                ${n?i`<div>
                      <span class="label">${c(`channels.nostr.displayName`)}</span
                      ><span>${n}</span>
                    </div>`:s}
                ${a?i`<div>
                      <span class="label">${c(`channels.nostr.about`)}</span
                      ><span style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;"
                        >${a}</span
                      >
                    </div>`:s}
                ${h?i`<div><span class="label">NIP-05</span><span>${h}</span></div>`:s}
              </div>
            `:i`
              <div style="color: var(--text-muted); font-size: 13px">
                ${c(`channels.nostr.noProfile`)} ${c(`channels.nostr.noProfileHint`)}
              </div>
            `}
      </div>
    `})()} ${g({channelId:`nostr`,props:n})}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${()=>n.onRefresh(!1)}>${c(`common.refresh`)}</button>
      </div>
    </div>
  `}function j(e){let{props:t,signal:n,accountCountLabel:r}=e,o=x(`signal`,t);return C({title:`Signal`,subtitle:`signal-cli status and channel configuration.`,accountCountLabel:r,statusRows:[{label:c(`common.configured`),value:S(o)},{label:c(`common.running`),value:n?.running?c(`common.yes`):c(`common.no`)},{label:c(`common.baseUrl`),value:n?.baseUrl??c(`common.na`)},{label:c(`common.lastStart`),value:n?.lastStartAt?a(n.lastStartAt):c(`common.na`)},{label:c(`common.lastProbe`),value:n?.lastProbeAt?a(n.lastProbeAt):c(`common.na`)}],lastError:n?.lastError,secondaryCallout:n?.probe?i`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?c(`common.probeOk`):c(`common.probeFailed`)} ·
          ${n.probe.status??``} ${n.probe.error??``}
        </div>`:s,configSection:g({channelId:`signal`,props:t}),footer:i`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>t.onRefresh(!0)}>${c(`common.probe`)}</button>
    </div>`})}function M(e){let{props:t,slack:n,accountCountLabel:r}=e,o=x(`slack`,t);return C({title:`Slack`,subtitle:`Socket mode status and channel configuration.`,accountCountLabel:r,statusRows:[{label:c(`common.configured`),value:S(o)},{label:c(`common.running`),value:n?.running?c(`common.yes`):c(`common.no`)},{label:c(`common.lastStart`),value:n?.lastStartAt?a(n.lastStartAt):c(`common.na`)},{label:c(`common.lastProbe`),value:n?.lastProbeAt?a(n.lastProbeAt):c(`common.na`)}],lastError:n?.lastError,secondaryCallout:n?.probe?i`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?c(`common.probeOk`):c(`common.probeFailed`)} ·
          ${n.probe.status??``} ${n.probe.error??``}
        </div>`:s,configSection:g({channelId:`slack`,props:t}),footer:i`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>t.onRefresh(!0)}>${c(`common.probe`)}</button>
    </div>`})}function N(e){let{props:t,telegram:n,telegramAccounts:r,accountCountLabel:o}=e,l=r.length>1,u=x(`telegram`,t),d=e=>{let t=e.probe?.bot?.username,n=e.name||e.accountId;return i`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${t?`@${t}`:n}</div>
          <div class="account-card-id">${e.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">${c(`common.running`)}</span>
            <span>${e.running?c(`common.yes`):c(`common.no`)}</span>
          </div>
          <div>
            <span class="label">${c(`common.configured`)}</span>
            <span>${e.configured?c(`common.yes`):c(`common.no`)}</span>
          </div>
          <div>
            <span class="label">${c(`common.lastInbound`)}</span>
            <span
              >${e.lastInboundAt?a(e.lastInboundAt):c(`common.na`)}</span
            >
          </div>
          ${e.lastError?i` <div class="account-card-error">${e.lastError}</div> `:s}
        </div>
      </div>
    `};return l?i`
      <div class="card">
        <div class="card-title">Telegram</div>
        <div class="card-sub">Bot status and channel configuration.</div>
        ${o}

        <div class="account-card-list">
          ${r.map(e=>d(e))}
        </div>

        ${n?.lastError?i`<div class="callout danger" style="margin-top: 12px;">${n.lastError}</div>`:s}
        ${n?.probe?i`<div class="callout" style="margin-top: 12px;">
              ${n.probe.ok?c(`common.probeOk`):c(`common.probeFailed`)} ·
              ${n.probe.status??``} ${n.probe.error??``}
            </div>`:s}
        ${g({channelId:`telegram`,props:t})}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${()=>t.onRefresh(!0)}>${c(`common.probe`)}</button>
        </div>
      </div>
    `:C({title:`Telegram`,subtitle:`Bot status and channel configuration.`,accountCountLabel:o,statusRows:[{label:c(`common.configured`),value:S(u)},{label:c(`common.running`),value:n?.running?c(`common.yes`):c(`common.no`)},{label:c(`common.mode`),value:n?.mode??c(`common.na`)},{label:c(`common.lastStart`),value:n?.lastStartAt?a(n.lastStartAt):c(`common.na`)},{label:c(`common.lastProbe`),value:n?.lastProbeAt?a(n.lastProbeAt):c(`common.na`)}],lastError:n?.lastError,secondaryCallout:n?.probe?i`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?c(`common.probeOk`):c(`common.probeFailed`)} ·
          ${n.probe.status??``} ${n.probe.error??``}
        </div>`:s,configSection:g({channelId:`telegram`,props:t}),footer:i`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>t.onRefresh(!0)}>${c(`common.probe`)}</button>
    </div>`})}function P(t){let{props:n,whatsapp:r,accountCountLabel:o}=t,l=x(`whatsapp`,n),u=r?.linked===!0,d=n.whatsappQrDataUrl!=null;return C({title:`WhatsApp`,subtitle:`Link WhatsApp Web and monitor connection health.`,accountCountLabel:o,statusRows:[{label:c(`common.configured`),value:S(l)},{label:c(`common.linked`),value:r?.linked?c(`common.yes`):c(`common.no`)},{label:c(`common.running`),value:r?.running?c(`common.yes`):c(`common.no`)},{label:c(`common.connected`),value:r?.connected?c(`common.yes`):c(`common.no`)},{label:c(`common.lastConnect`),value:r?.lastConnectedAt?a(r.lastConnectedAt):c(`common.na`)},{label:c(`common.lastMessage`),value:r?.lastMessageAt?a(r.lastMessageAt):c(`common.na`)},{label:c(`common.authAge`),value:r?.authAgeMs==null?c(`common.na`):e(r.authAgeMs)}],lastError:r?.lastError,extraContent:i`
      ${n.whatsappMessage?i`<div class="callout" style="margin-top: 12px;">${n.whatsappMessage}</div>`:s}
      ${n.whatsappQrDataUrl?i`<div class="qr-wrap">
            <img src=${n.whatsappQrDataUrl} alt="WhatsApp QR" />
          </div>`:s}
    `,configSection:g({channelId:`whatsapp`,props:n}),footer:i`<div class="row" style="margin-top: 14px; flex-wrap: wrap;">
      ${u?i`<button
            class="btn"
            ?disabled=${n.whatsappBusy}
            @click=${()=>n.onWhatsAppStart(!0)}
          >
            ${c(`common.relink`)}
          </button>`:i`<button
            class="btn primary"
            ?disabled=${n.whatsappBusy}
            @click=${()=>n.onWhatsAppStart(!1)}
          >
            ${n.whatsappBusy?c(`common.working`):c(`common.showQr`)}
          </button>`}
      ${d?i`<button
            class="btn"
            ?disabled=${n.whatsappBusy}
            @click=${()=>n.onWhatsAppWait()}
          >
            ${c(`common.waitForScan`)}
          </button>`:s}
      <button
        class="btn danger"
        ?disabled=${n.whatsappBusy}
        @click=${()=>n.onWhatsAppLogout()}
      >
        ${c(`common.logout`)}
      </button>
      <button class="btn" @click=${()=>n.onRefresh(!0)}>${c(`common.refresh`)}</button>
    </div>`})}function F(e){let t=e.snapshot?.channels,n=t?.whatsapp??void 0,r=t?.telegram??void 0,o=t?.discord??null,l=t?.googlechat??null,u=t?.slack??null,d=t?.signal??null,f=t?.imessage??null,p=t?.nostr??null,m=I(e.snapshot).map((t,n)=>({key:t,enabled:b(t,e),order:n})).toSorted((e,t)=>e.enabled===t.enabled?e.order-t.order:e.enabled?-1:1),h=!!(e.loading&&e.snapshot&&e.lastSuccessAt),g=e.snapshot?.warnings?.filter(e=>e.trim())??[];return i`
    <section class="grid grid-cols-2">
      ${m.map(t=>L(t.key,e,{whatsapp:n,telegram:r,discord:o,googlechat:l,slack:u,signal:d,imessage:f,nostr:p,channelAccounts:e.snapshot?.channelAccounts??null}))}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${c(`channels.health.title`)}</div>
          <div class="card-sub">${c(`channels.health.subtitle`)}</div>
        </div>
        <div class="muted">
          ${e.lastSuccessAt?a(e.lastSuccessAt):c(`common.na`)}
        </div>
      </div>
      ${h?i`
            <div class="callout info" style="margin-top: 12px;">
              Refreshing channel status in the background; showing the last successful snapshot.
            </div>
          `:s}
      ${e.snapshot?.partial?i`
            <div class="callout warn" style="margin-top: 12px;">
              Some channel checks did not finish before the UI budget.
              ${g.length>0?g.slice(0,3).join(`; `):``}
            </div>
          `:s}
      ${e.lastError?i`<div class="callout danger" style="margin-top: 12px;">${e.lastError}</div>`:s}
      <pre class="code-block" style="margin-top: 12px;">
${e.snapshot?JSON.stringify(e.snapshot,null,2):c(`channels.health.noSnapshotYet`)}
      </pre
      >
    </section>
  `}function I(e){return e?.channelMeta?.length?e.channelMeta.map(e=>e.id):e?.channelOrder?.length?e.channelOrder:[`whatsapp`,`telegram`,`discord`,`googlechat`,`slack`,`signal`,`imessage`,`nostr`]}function L(e,t,n){let r=T(e,n.channelAccounts);switch(e){case`whatsapp`:return P({props:t,whatsapp:n.whatsapp,accountCountLabel:r});case`telegram`:return N({props:t,telegram:n.telegram,telegramAccounts:n.channelAccounts?.telegram??[],accountCountLabel:r});case`discord`:return E({props:t,discord:n.discord,accountCountLabel:r});case`googlechat`:return D({props:t,googleChat:n.googlechat,accountCountLabel:r});case`slack`:return M({props:t,slack:n.slack,accountCountLabel:r});case`signal`:return j({props:t,signal:n.signal,accountCountLabel:r});case`imessage`:return O({props:t,imessage:n.imessage,accountCountLabel:r});case`nostr`:{let e=n.channelAccounts?.nostr??[],i=e[0],a=i?.accountId??`default`,o=i?.profile??null,s=t.nostrProfileAccountId===a?t.nostrProfileFormState:null,c=s?{onFieldChange:t.onNostrProfileFieldChange,onSave:t.onNostrProfileSave,onImport:t.onNostrProfileImport,onCancel:t.onNostrProfileCancel,onToggleAdvanced:t.onNostrProfileToggleAdvanced}:null;return A({props:t,nostr:n.nostr,nostrAccounts:e,accountCountLabel:r,profileFormState:s,profileFormCallbacks:c,onEditProfile:()=>t.onNostrProfileEdit(a,o)})}default:return R(e,t,n.channelAccounts??{})}}function R(e,t,n){let r=B(t.snapshot,e),a=y(e,t),o=typeof a.status?.lastError==`string`?a.status.lastError:void 0,l=n[e]??[],u=T(e,n);return i`
    <div class="card">
      <div class="card-title">${r}</div>
      <div class="card-sub">${c(`channels.generic.subtitle`)}</div>
      ${u}
      ${l.length>0?i`
            <div class="account-card-list">
              ${l.map(e=>G(e))}
            </div>
          `:i`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">${c(`common.configured`)}</span>
                <span>${S(a.configured)}</span>
              </div>
              <div>
                <span class="label">${c(`common.running`)}</span>
                <span>${S(a.running)}</span>
              </div>
              <div>
                <span class="label">${c(`common.connected`)}</span>
                <span>${S(a.connected)}</span>
              </div>
            </div>
          `}
      ${o?i`<div class="callout danger" style="margin-top: 12px;">${o}</div>`:s}
      ${g({channelId:e,props:t})}
    </div>
  `}function z(e){return e?.channelMeta?.length?Object.fromEntries(e.channelMeta.map(e=>[e.id,e])):{}}function B(e,t){return z(e)[t]?.label??e?.channelLabels?.[t]??t}var V=600*1e3;function H(e){return e.lastInboundAt?Date.now()-e.lastInboundAt<V:!1}function U(e){return e.running?c(`common.yes`):H(e)?c(`common.active`):c(`common.no`)}function W(e){return e.connected===!0?c(`common.yes`):e.connected===!1?c(`common.no`):H(e)?c(`common.active`):c(`common.na`)}function G(e){let t=U(e),n=W(e);return i`
    <div class="account-card">
      <div class="account-card-header">
        <div class="account-card-title">${e.name||e.accountId}</div>
        <div class="account-card-id">${e.accountId}</div>
      </div>
      <div class="status-list account-card-status">
        <div>
          <span class="label">${c(`common.running`)}</span>
          <span>${t}</span>
        </div>
        <div>
          <span class="label">${c(`common.configured`)}</span>
          <span>${e.configured?c(`common.yes`):c(`common.no`)}</span>
        </div>
        <div>
          <span class="label">${c(`common.connected`)}</span>
          <span>${n}</span>
        </div>
        <div>
          <span class="label">${c(`common.lastInbound`)}</span>
          <span
            >${e.lastInboundAt?a(e.lastInboundAt):c(`common.na`)}</span
          >
        </div>
        ${e.lastError?i` <div class="account-card-error">${e.lastError}</div> `:s}
      </div>
    </div>
  `}export{F as renderChannels};
//# sourceMappingURL=channels-DNamIaMH.js.map