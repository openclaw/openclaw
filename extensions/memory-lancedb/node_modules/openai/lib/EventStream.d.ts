import { APIUserAbortError, OpenAIError } from "../error.js";
export declare class EventStream<EventTypes extends BaseEvents> {
    #private;
    controller: AbortController;
    constructor();
    protected _run(this: EventStream<EventTypes>, executor: () => Promise<any>): void;
    protected _connected(this: EventStream<EventTypes>): void;
    get ended(): boolean;
    get errored(): boolean;
    get aborted(): boolean;
    abort(): void;
    /**
     * Adds the listener function to the end of the listeners array for the event.
     * No checks are made to see if the listener has already been added. Multiple calls passing
     * the same combination of event and listener will result in the listener being added, and
     * called, multiple times.
     * @returns this ChatCompletionStream, so that calls can be chained
     */
    on<Event extends keyof EventTypes>(event: Event, listener: EventListener<EventTypes, Event>): this;
    /**
     * Removes the specified listener from the listener array for the event.
     * off() will remove, at most, one instance of a listener from the listener array. If any single
     * listener has been added multiple times to the listener array for the specified event, then
     * off() must be called multiple times to remove each instance.
     * @returns this ChatCompletionStream, so that calls can be chained
     */
    off<Event extends keyof EventTypes>(event: Event, listener: EventListener<EventTypes, Event>): this;
    /**
     * Adds a one-time listener function for the event. The next time the event is triggered,
     * this listener is removed and then invoked.
     * @returns this ChatCompletionStream, so that calls can be chained
     */
    once<Event extends keyof EventTypes>(event: Event, listener: EventListener<EventTypes, Event>): this;
    /**
     * This is similar to `.once()`, but returns a Promise that resolves the next time
     * the event is triggered, instead of calling a listener callback.
     * @returns a Promise that resolves the next time given event is triggered,
     * or rejects if an error is emitted.  (If you request the 'error' event,
     * returns a promise that resolves with the error).
     *
     * Example:
     *
     *   const message = await stream.emitted('message') // rejects if the stream errors
     */
    emitted<Event extends keyof EventTypes>(event: Event): Promise<EventParameters<EventTypes, Event> extends [infer Param] ? Param : EventParameters<EventTypes, Event> extends [] ? void : EventParameters<EventTypes, Event>>;
    done(): Promise<void>;
    _emit<Event extends keyof BaseEvents>(event: Event, ...args: EventParameters<BaseEvents, Event>): void;
    _emit<Event extends keyof EventTypes>(event: Event, ...args: EventParameters<EventTypes, Event>): void;
    protected _emitFinal(): void;
}
type EventListener<Events, EventType extends keyof Events> = Events[EventType];
export type EventParameters<Events, EventType extends keyof Events> = {
    [Event in EventType]: EventListener<Events, EventType> extends (...args: infer P) => any ? P : never;
}[EventType];
export interface BaseEvents {
    connect: () => void;
    error: (error: OpenAIError) => void;
    abort: (error: APIUserAbortError) => void;
    end: () => void;
}
export {};
//# sourceMappingURL=EventStream.d.ts.map