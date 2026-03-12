export declare const WizardStartParamsSchema: import("@sinclair/typebox").TObject<{
    mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"local">, import("@sinclair/typebox").TLiteral<"remote">]>>;
    workspace: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const WizardAnswerSchema: import("@sinclair/typebox").TObject<{
    stepId: import("@sinclair/typebox").TString;
    value: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
}>;
export declare const WizardNextParamsSchema: import("@sinclair/typebox").TObject<{
    sessionId: import("@sinclair/typebox").TString;
    answer: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        stepId: import("@sinclair/typebox").TString;
        value: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    }>>;
}>;
export declare const WizardCancelParamsSchema: import("@sinclair/typebox").TObject<{
    sessionId: import("@sinclair/typebox").TString;
}>;
export declare const WizardStatusParamsSchema: import("@sinclair/typebox").TObject<{
    sessionId: import("@sinclair/typebox").TString;
}>;
export declare const WizardStepOptionSchema: import("@sinclair/typebox").TObject<{
    value: import("@sinclair/typebox").TUnknown;
    label: import("@sinclair/typebox").TString;
    hint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const WizardStepSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    type: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"note">, import("@sinclair/typebox").TLiteral<"select">, import("@sinclair/typebox").TLiteral<"text">, import("@sinclair/typebox").TLiteral<"confirm">, import("@sinclair/typebox").TLiteral<"multiselect">, import("@sinclair/typebox").TLiteral<"progress">, import("@sinclair/typebox").TLiteral<"action">]>;
    title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    options: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        value: import("@sinclair/typebox").TUnknown;
        label: import("@sinclair/typebox").TString;
        hint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>>;
    initialValue: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    executor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"gateway">, import("@sinclair/typebox").TLiteral<"client">]>>;
}>;
export declare const WizardNextResultSchema: import("@sinclair/typebox").TObject<{
    done: import("@sinclair/typebox").TBoolean;
    step: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"note">, import("@sinclair/typebox").TLiteral<"select">, import("@sinclair/typebox").TLiteral<"text">, import("@sinclair/typebox").TLiteral<"confirm">, import("@sinclair/typebox").TLiteral<"multiselect">, import("@sinclair/typebox").TLiteral<"progress">, import("@sinclair/typebox").TLiteral<"action">]>;
        title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        options: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            value: import("@sinclair/typebox").TUnknown;
            label: import("@sinclair/typebox").TString;
            hint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>>;
        initialValue: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        executor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"gateway">, import("@sinclair/typebox").TLiteral<"client">]>>;
    }>>;
    status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"running">, import("@sinclair/typebox").TLiteral<"done">, import("@sinclair/typebox").TLiteral<"cancelled">, import("@sinclair/typebox").TLiteral<"error">]>>;
    error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const WizardStartResultSchema: import("@sinclair/typebox").TObject<{
    done: import("@sinclair/typebox").TBoolean;
    step: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"note">, import("@sinclair/typebox").TLiteral<"select">, import("@sinclair/typebox").TLiteral<"text">, import("@sinclair/typebox").TLiteral<"confirm">, import("@sinclair/typebox").TLiteral<"multiselect">, import("@sinclair/typebox").TLiteral<"progress">, import("@sinclair/typebox").TLiteral<"action">]>;
        title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        options: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            value: import("@sinclair/typebox").TUnknown;
            label: import("@sinclair/typebox").TString;
            hint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>>;
        initialValue: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        executor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"gateway">, import("@sinclair/typebox").TLiteral<"client">]>>;
    }>>;
    status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"running">, import("@sinclair/typebox").TLiteral<"done">, import("@sinclair/typebox").TLiteral<"cancelled">, import("@sinclair/typebox").TLiteral<"error">]>>;
    error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionId: import("@sinclair/typebox").TString;
}>;
export declare const WizardStatusResultSchema: import("@sinclair/typebox").TObject<{
    status: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"running">, import("@sinclair/typebox").TLiteral<"done">, import("@sinclair/typebox").TLiteral<"cancelled">, import("@sinclair/typebox").TLiteral<"error">]>;
    error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
