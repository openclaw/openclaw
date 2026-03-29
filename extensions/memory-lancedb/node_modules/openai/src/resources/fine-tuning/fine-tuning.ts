// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as MethodsAPI from './methods';
import {
  DpoHyperparameters,
  DpoMethod,
  Methods,
  ReinforcementHyperparameters,
  ReinforcementMethod,
  SupervisedHyperparameters,
  SupervisedMethod,
} from './methods';
import * as AlphaAPI from './alpha/alpha';
import { Alpha } from './alpha/alpha';
import * as CheckpointsAPI from './checkpoints/checkpoints';
import { Checkpoints } from './checkpoints/checkpoints';
import * as JobsAPI from './jobs/jobs';
import {
  FineTuningJob,
  FineTuningJobEvent,
  FineTuningJobEventsPage,
  FineTuningJobIntegration,
  FineTuningJobWandbIntegration,
  FineTuningJobWandbIntegrationObject,
  FineTuningJobsPage,
  JobCreateParams,
  JobListEventsParams,
  JobListParams,
  Jobs,
} from './jobs/jobs';

export class FineTuning extends APIResource {
  methods: MethodsAPI.Methods = new MethodsAPI.Methods(this._client);
  jobs: JobsAPI.Jobs = new JobsAPI.Jobs(this._client);
  checkpoints: CheckpointsAPI.Checkpoints = new CheckpointsAPI.Checkpoints(this._client);
  alpha: AlphaAPI.Alpha = new AlphaAPI.Alpha(this._client);
}

FineTuning.Methods = Methods;
FineTuning.Jobs = Jobs;
FineTuning.Checkpoints = Checkpoints;
FineTuning.Alpha = Alpha;

export declare namespace FineTuning {
  export {
    Methods as Methods,
    type DpoHyperparameters as DpoHyperparameters,
    type DpoMethod as DpoMethod,
    type ReinforcementHyperparameters as ReinforcementHyperparameters,
    type ReinforcementMethod as ReinforcementMethod,
    type SupervisedHyperparameters as SupervisedHyperparameters,
    type SupervisedMethod as SupervisedMethod,
  };

  export {
    Jobs as Jobs,
    type FineTuningJob as FineTuningJob,
    type FineTuningJobEvent as FineTuningJobEvent,
    type FineTuningJobWandbIntegration as FineTuningJobWandbIntegration,
    type FineTuningJobWandbIntegrationObject as FineTuningJobWandbIntegrationObject,
    type FineTuningJobIntegration as FineTuningJobIntegration,
    type FineTuningJobsPage as FineTuningJobsPage,
    type FineTuningJobEventsPage as FineTuningJobEventsPage,
    type JobCreateParams as JobCreateParams,
    type JobListParams as JobListParams,
    type JobListEventsParams as JobListEventsParams,
  };

  export { Checkpoints as Checkpoints };

  export { Alpha as Alpha };
}
