import { Errored, createEffect, createMemo, createSignal, onSettled } from "solid-js";

/** Read through to the synchronous owner; notifications invalidate without copying its state. */
export function observeSource(read, subscribe) {
  const [revision, setRevision] = createSignal(0);
  onSettled(() => subscribe(() => setRevision((value) => value + 1)));
  return {
    revision,
    read: () => {
      revision();
      return read();
    },
  };
}

export function CatalogBoundary(props) {
  return (
    <Errored
      fallback={(_error, reset) => (
        <div class="error" role="alert">
          Unable to render component.{" "}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              reset();
            }}
          >
            Retry
          </button>
        </div>
      )}
    >
      {props.children}
    </Errored>
  );
}

export const catalogAlignment = (value) =>
  ({
    start: "flex-start",
    end: "flex-end",
    spaceAround: "space-around",
    spaceBetween: "space-between",
    spaceEvenly: "space-evenly",
  })[value] ?? value;

/** Commit-on-change fields keep their native draft when unrelated props change. */
export function catalogInputValue(read) {
  let field;
  const value = createMemo(read);
  const write = (next) => {
    if (field && field.value !== next) {
      field.value = next;
    }
  };
  createEffect(value, write);
  return (element) => {
    field = element;
    write(value());
  };
}

/** Both dialects keep their catalog markup; the native dialog owns focus and dismissal. */
export function CatalogDialog(props) {
  let dialog;
  onSettled(() => () => {
    if (dialog.open) {
      dialog.close();
    }
  });
  return (
    <>
      <div class={props.triggerClass} onClick={() => dialog.showModal()}>
        {props.trigger}
      </div>
      <dialog
        class={props.class}
        ref={(element) => {
          dialog = element;
        }}
        onClick={(event) => {
          if (event.target === dialog) {
            dialog.close();
          }
        }}
      >
        {props.children(() => dialog.close())}
      </dialog>
    </>
  );
}
