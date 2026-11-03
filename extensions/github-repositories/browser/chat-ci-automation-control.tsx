/** @jsxImportSource @solidjs/web */
import {
  Errored,
  Loading,
  Show,
  createMemo,
  createSignal,
  createStore,
  createEffect,
  isPending,
  latest,
  useContext,
} from "solid-js";
import type {
  CiAutomationOption,
  CiAutomationOptions,
  CiAutomationTarget,
} from "../session-pr-automation-api.ts";
import {
  ChatCiAutomationError,
  ChatCiAutomationView,
  type ChatCiAutomationProps as ChatCiAutomationViewProps,
} from "./chat-ci-automation.tsx";
import { createCiDisclosure, type ChatCiDisclosureProps } from "./chat-ci-disclosure.ts";
import { RepositoryCiContext } from "./ci-context.ts";
import type { MenuControls } from "./presentation-components.tsx";
import { PresentationContext, presentationTranslator } from "./presentation-context.ts";
import {
  loadCiAutomationJobs,
  setCiAutomationEnabled,
  type CiAutomationJobs,
} from "./session-pr-automation.ts";
type CronStatus = {
  enabled: boolean;
  triggersEnabled: boolean;
  jobs: number;
  nextWakeAtMs?: number | null;
};
export type ChatCiAutomationProps = ChatCiDisclosureProps & {
  sessionId: string;
  menuPresentation?: boolean;
  controls?: MenuControls;
};
type Props = ChatCiAutomationProps;
type AutomationState = {
  jobs: CiAutomationJobs;
  inventoryReady: boolean;
  pending: Partial<CiAutomationOptions>;
  schedulerEnabled: boolean | undefined;
};
type Inventory = { jobs: CiAutomationJobs; schedulerEnabled: boolean };
export function ChatCiAutomation(props: ChatCiAutomationProps) {
  const services = useContext(RepositoryCiContext);
  const presentation = useContext(PresentationContext);
  const formatUiError = presentation.formatError;
  const t = presentationTranslator();
  let element!: HTMLElement;
  function createCiAutomation() {
    const [state, setState] = createStore<AutomationState>({
      jobs: {},
      inventoryReady: false,
      pending: {},
      schedulerEnabled: undefined,
    });
    const [connectionPulse, setConnectionPulse] = createSignal(0);
    let boundRequests: typeof services.requests | undefined;
    let connectionRevision = -1;
    let version = 0;
    let inventoryVersion = -1;
    let readController: AbortController | undefined;
    let refreshPending = true;
    let stopGateway: (() => void) | undefined;
    let stopEvents: (() => void) | undefined;
    let targetKey = "";
    let sessionKey = "";
    let sessionId = "";
    // Revision admission reads this synchronous snapshot; the store only presents it.
    let accepted: Inventory | undefined;
    const [receipt, setReceipt] = createSignal(Promise.resolve<Inventory | undefined>(undefined));
    const read = createMemo(() => receipt());
    const [presentationScope, setPresentationScope] = createSignal({});
    const completions = new Set<Promise<void>>();
    const [attempt, setAttempt] = createSignal<{ result: Promise<null> }>();
    // Synchronous admission is separate from Solid's deferred presentation writes.
    const writes = new Set<CiAutomationOption>();
    const disclosure = createCiDisclosure(
      () => element,
      () => props,
      handleVisibility,
      () => {
        bindGateway();
        syncTarget();
        return () => {
          stopGateway?.();
          stopEvents?.();
          version += 1;
          readController?.abort();
        };
      },
    );

    function bindGateway() {
      if (boundRequests === services.requests) {
        return;
      }
      boundRequests = services.requests;
      stopGateway?.();
      stopEvents?.();
      const source = services.requests;
      reset();
      // Retire request authority on every connection transition, before subsequent events.
      stopGateway = source?.subscribe(() => {
        syncConnection();
        queueRefresh();
      });
      stopEvents = source?.subscribeEvents((event) => {
        if (source.isCronInventoryInvalidation(event)) {
          invalidate();
        }
      });
      syncConnection();
      queueRefresh();
    }

    function syncTarget() {
      const next = JSON.stringify([props.sessionKey, props.sessionId, automationTarget()]);
      if (targetKey === next) {
        return false;
      }
      if (
        (sessionKey && sessionKey !== props.sessionKey) ||
        (sessionId && sessionId !== props.sessionId)
      ) {
        disclosure.close();
      }
      targetKey = next;
      sessionKey = props.sessionKey;
      sessionId = props.sessionId;
      reset();
      return true;
    }

    let previousVisibility: boolean | undefined;
    function syncInputs() {
      if (boundRequests !== services.requests) {
        bindGateway();
      }
      const targetChanged = syncTarget();
      const visibility = disclosure.visible();
      const visibilityChanged = previousVisibility !== visibility;
      previousVisibility = visibility;
      if (targetChanged || visibilityChanged) {
        handleVisibility();
      }
    }
    function queueRefresh() {
      queueMicrotask(() => {
        if (refreshPending && disclosure.visible() && !readController && !writes.size) {
          load();
        }
      });
    }

    function automationTarget(source: Props = props): CiAutomationTarget | null {
      const pr = source.pullRequest;
      const agentId = services.agentId(source.sessionKey);
      if (!pr || !agentId || !source.sessionId.trim()) {
        return null;
      }
      return {
        sessionKey: source.sessionKey,
        sessionId: source.sessionId,
        agentId,
        owner: pr.owner.toLowerCase(),
        repo: pr.repo.toLowerCase(),
        number: pr.number,
      };
    }

    function canRead(): boolean {
      return ["cron.list", "cron.status"].every((method) =>
        services.requests?.canCall(method, "operator.read", false),
      );
    }

    function canManage(): boolean {
      return ["cron.add", "cron.update"].every((method) =>
        services.requests?.canCall(method, "operator.admin", false),
      );
    }

    function syncConnection(): void {
      const revision = services.requests?.revision ?? -1;
      if (revision !== connectionRevision) {
        connectionRevision = revision;
        setConnectionPulse((value) => value + 1);
        reset();
      }
    }

    function cancelRead(): void {
      if (!readController) {
        return;
      }
      readController.abort();
      readController = undefined;
      void setReceipt(Promise.resolve(accepted));
      refreshPending = true;
    }

    function reset(): void {
      version += 1;
      completions.clear();
      setAttempt(undefined);
      setPresentationScope({});
      cancelRead();
      inventoryVersion = -1;
      accepted = undefined;
      writes.clear();
      setState((draft) => {
        draft.jobs = {};
        draft.inventoryReady = false;
        draft.pending = {};
        draft.schedulerEnabled = undefined;
      });
      void setReceipt(Promise.resolve(undefined));
      refreshPending = true;
    }

    function invalidate(): void {
      // One trailing authoritative read absorbs event bursts and in-flight writes.
      refreshPending = true;
      queueRefresh();
    }

    function handleVisibility(): void {
      // Native toggle receipts also update the input observer's visibility baseline.
      previousVisibility = disclosure.visible();
      if (!previousVisibility) {
        cancelRead();
      }
      invalidate();
    }

    function capture() {
      const gateway = services.requests;
      const scope = services.requests?.capture();
      const target = automationTarget();
      const pullRequest = props.pullRequest;
      if (!gateway || !scope || !target || !pullRequest) {
        return null;
      }
      const capturedVersion = version;
      const input = {
        sessionKey: props.sessionKey,
        sessionId: props.sessionId,
        // Cron declarations follow the PR, not an individual head revision.
        pullRequest: {
          owner: pullRequest.owner,
          repo: pullRequest.repo,
          number: pullRequest.number,
        },
      };
      return {
        client: scope,
        target,
        current: () =>
          disclosure.isConnected() &&
          capturedVersion === version &&
          services.isCurrent(input) &&
          gateway === services.requests &&
          scope.isCurrent(),
      };
    }

    function load(): void {
      if (!disclosure.visible() || readController || writes.size) {
        return;
      }
      refreshPending = false;
      const owner = capture();
      if (!owner || !owner.current() || !canRead()) {
        queueRefresh();
        return;
      }
      const admitted = owner;
      const controller = new AbortController();
      readController = controller;
      queueRefresh();
      const current = () =>
        owner.current() && disclosure.visible() && readController === controller;
      const result = request();
      void setReceipt(result);
      // The boundary owns the visible error; cancellation may retire its reader first.
      void result.catch(() => {});

      async function request(): Promise<Inventory | undefined> {
        try {
          const [jobs, status] = await Promise.all([
            loadCiAutomationJobs(admitted.client, admitted.target, controller.signal),
            admitted.client.request<CronStatus>("cron.status", {}, { signal: controller.signal }),
          ]);
          if (current()) {
            inventoryVersion = version;
            accepted = { jobs, schedulerEnabled: status.enabled };
            setState((draft) => {
              draft.jobs = jobs;
              draft.inventoryReady = true;
              draft.schedulerEnabled = status.enabled;
            });
            return accepted;
          }
          return undefined;
        } catch (error) {
          if (current()) {
            inventoryVersion = -1;
            setState((draft) => {
              draft.inventoryReady = false;
            });
            throw new Error(formatUiError(error, t("chat.pullRequests.automationLoadFailed")), {
              cause: error,
            });
          }
          return undefined;
        } finally {
          if (current()) {
            readController = undefined;
            queueRefresh();
          }
        }
      }
    }

    function setEnabled(option: CiAutomationOption, enabled: boolean): void {
      // Input publication can precede the presentation receipt; retire old inventory at the write boundary.
      if (syncTarget()) {
        return;
      }
      if (
        !disclosure.visible() ||
        inventoryVersion !== version ||
        writes.has(option) ||
        !canRead() ||
        !canManage()
      ) {
        return;
      }
      const owner = capture();
      if (!owner || !owner.current()) {
        return;
      }
      const admitted = owner;
      const currentJob = accepted?.jobs[option];
      // A pre-click inventory must never overwrite newer intent or its acknowledged revision.
      cancelRead();
      writes.add(option);
      // Same-turn actions share a transaction. Keep per-option settlement independent.
      setState((draft) => {
        draft.pending[option] = enabled;
      });
      const completion = commit();
      completions.add(completion);
      // Keep the first concurrent failure visible through the remaining sibling completions.
      const result = Promise.all(completions).then(() => null);
      setAttempt({ result });
      void result.catch(() => {});
      void completion.catch(() => {}).finally(() => completions.delete(completion));
      queueRefresh();

      async function commit() {
        try {
          const job = await setCiAutomationEnabled(
            admitted.client,
            admitted.target,
            option,
            enabled,
            currentJob,
          );
          if (!admitted.current()) {
            return;
          }
          if (accepted) {
            accepted = { ...accepted, jobs: { ...accepted.jobs, [option]: job } };
          }
          setState((draft) => {
            draft.jobs[option] = job;
          });
        } catch (error) {
          if (admitted.current()) {
            // A rejected acknowledgement may hide an accepted write. Never mutate again
            // until a complete authoritative inventory has reconciled the actual outcome.
            inventoryVersion = -1;
            setState((draft) => {
              draft.inventoryReady = false;
            });
            throw new Error(formatUiError(error, t("chat.pullRequests.automationSaveFailed")), {
              cause: error,
            });
          }
        } finally {
          if (admitted.current()) {
            writes.delete(option);
            setState((draft) => {
              delete draft.pending[option];
            });
            queueRefresh();
          }
        }
      }
    }

    type ViewProps = Omit<ChatCiAutomationViewProps, "loading" | "error">;
    const view = createMemo<ViewProps>(() => {
      connectionPulse();
      const unavailable = !automationTarget(props)
        ? t("chat.pullRequests.automationSessionRequired")
        : !canRead()
          ? t("chat.pullRequests.automationReadRequired")
          : !canManage()
            ? t("chat.pullRequests.automationAdminRequired")
            : undefined;
      return {
        options: {
          autoFix: state.pending.autoFix ?? state.jobs.autoFix?.enabled === true,
          autoMerge: state.pending.autoMerge ?? state.jobs.autoMerge?.enabled === true,
          autoArchive: state.pending.autoArchive ?? state.jobs.autoArchive?.enabled === true,
        },
        pending: state.pending,
        saving: Object.keys(state.pending).length > 0,
        jobs: state.jobs,
        schedulerEnabled: state.schedulerEnabled,
        disabled: Boolean(unavailable),
        disabledReason: unavailable,
        retryDisabled: !automationTarget(props) || !canRead(),
        onChange: (option, enabled) => setEnabled(option, enabled),
        onRetry: () => {
          setAttempt(undefined);
          refreshPending = true;
          load();
        },
      };
    });
    return {
      view,
      syncInputs,
      attempt,
      read,
      scope: presentationScope,
      hasInventory: () => {
        latest(read);
        return state.inventoryReady;
      },
    };
  }
  const model = createCiAutomation();
  createEffect(
    () => [
      services.requests,
      props.sessionKey,
      props.sessionId,
      props.pullRequest,
      props.presented,
      props.inline,
    ],
    () => model.syncInputs(),
  );

  function Content() {
    const content = (loading = false, error?: () => string, retry?: () => void) => (
      <ChatCiAutomationView
        {...model.view()}
        errorContent={
          <Show when={error ? undefined : model.attempt()} keyed>
            {(attempt) => {
              const outcome = createMemo(() => attempt.result, { loadingValue: undefined });
              return (
                <Errored
                  fallback={(mutationError) => (
                    <ChatCiAutomationError
                      error={formatUiError(mutationError())}
                      loading={isPending(model.read)}
                      saving={model.view().saving}
                      retryDisabled={model.view().retryDisabled}
                      onRetry={model.view().onRetry}
                      controls={props.controls}
                    />
                  )}
                >
                  {outcome()}
                </Errored>
              );
            }}
          </Show>
        }
        loading={loading || isPending(model.read)}
        disabled={loading || Boolean(error) || model.view().disabled || !model.hasInventory()}
        error={error ? error() : null}
        onRetry={retry ?? model.view().onRetry}
        menuPresentation={props.menuPresentation}
        controls={props.controls}
      />
    );
    return (
      <Errored
        fallback={(error, reset) =>
          content(
            false,
            () => formatUiError(error()),
            () => {
              model.view().onRetry();
              reset();
            },
          )
        }
      >
        <Loading on={model.scope()} fallback={content(true)}>
          {(latest(model.read), null)}
          {content()}
        </Loading>
      </Errored>
    );
  }
  return (
    <openclaw-chat-ci-automation ref={(node) => (element = node)}>
      <Content />
    </openclaw-chat-ci-automation>
  );
}
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-ci-automation": HTMLAttributes<HTMLElement>;
    }
  }
}
