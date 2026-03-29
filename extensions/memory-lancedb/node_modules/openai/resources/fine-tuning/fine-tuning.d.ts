import { APIResource } from "../../core/resource.js";
import * as MethodsAPI from "./methods.js";
import { DpoHyperparameters, DpoMethod, Methods, ReinforcementHyperparameters, ReinforcementMethod, SupervisedHyperparameters, SupervisedMethod } from "./methods.js";
import * as AlphaAPI from "./alpha/alpha.js";
import { Alpha } from "./alpha/alpha.js";
import * as CheckpointsAPI from "./checkpoints/checkpoints.js";
import { Checkpoints } from "./checkpoints/checkpoints.js";
import * as JobsAPI from "./jobs/jobs.js";
import { FineTuningJob, FineTuningJobEvent, FineTuningJobEventsPage, FineTuningJobIntegration, FineTuningJobWandbIntegration, FineTuningJobWandbIntegrationObject, FineTuningJobsPage, JobCreateParams, JobListEventsParams, JobListParams, Jobs } from "./jobs/jobs.js";
export declare class FineTuning extends APIResource {
    methods: MethodsAPI.Methods;
    jobs: JobsAPI.Jobs;
    checkpoints: CheckpointsAPI.Checkpoints;
    alpha: AlphaAPI.Alpha;
}
export declare namespace FineTuning {
    export { Methods as Methods, type DpoHyperparameters as DpoHyperparameters, type DpoMethod as DpoMethod, type ReinforcementHyperparameters as ReinforcementHyperparameters, type ReinforcementMethod as ReinforcementMethod, type SupervisedHyperparameters as SupervisedHyperparameters, type SupervisedMethod as SupervisedMethod, };
    export { Jobs as Jobs, type FineTuningJob as FineTuningJob, type FineTuningJobEvent as FineTuningJobEvent, type FineTuningJobWandbIntegration as FineTuningJobWandbIntegration, type FineTuningJobWandbIntegrationObject as FineTuningJobWandbIntegrationObject, type FineTuningJobIntegration as FineTuningJobIntegration, type FineTuningJobsPage as FineTuningJobsPage, type FineTuningJobEventsPage as FineTuningJobEventsPage, type JobCreateParams as JobCreateParams, type JobListParams as JobListParams, type JobListEventsParams as JobListEventsParams, };
    export { Checkpoints as Checkpoints };
    export { Alpha as Alpha };
}
//# sourceMappingURL=fine-tuning.d.ts.map