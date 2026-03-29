import { APIResource } from "../../core/resource.js";
import * as GraderModelsAPI from "../graders/grader-models.js";
export declare class Methods extends APIResource {
}
/**
 * The hyperparameters used for the DPO fine-tuning job.
 */
export interface DpoHyperparameters {
    /**
     * Number of examples in each batch. A larger batch size means that model
     * parameters are updated less frequently, but with lower variance.
     */
    batch_size?: 'auto' | number;
    /**
     * The beta value for the DPO method. A higher beta value will increase the weight
     * of the penalty between the policy and reference model.
     */
    beta?: 'auto' | number;
    /**
     * Scaling factor for the learning rate. A smaller learning rate may be useful to
     * avoid overfitting.
     */
    learning_rate_multiplier?: 'auto' | number;
    /**
     * The number of epochs to train the model for. An epoch refers to one full cycle
     * through the training dataset.
     */
    n_epochs?: 'auto' | number;
}
/**
 * Configuration for the DPO fine-tuning method.
 */
export interface DpoMethod {
    /**
     * The hyperparameters used for the DPO fine-tuning job.
     */
    hyperparameters?: DpoHyperparameters;
}
/**
 * The hyperparameters used for the reinforcement fine-tuning job.
 */
export interface ReinforcementHyperparameters {
    /**
     * Number of examples in each batch. A larger batch size means that model
     * parameters are updated less frequently, but with lower variance.
     */
    batch_size?: 'auto' | number;
    /**
     * Multiplier on amount of compute used for exploring search space during training.
     */
    compute_multiplier?: 'auto' | number;
    /**
     * The number of training steps between evaluation runs.
     */
    eval_interval?: 'auto' | number;
    /**
     * Number of evaluation samples to generate per training step.
     */
    eval_samples?: 'auto' | number;
    /**
     * Scaling factor for the learning rate. A smaller learning rate may be useful to
     * avoid overfitting.
     */
    learning_rate_multiplier?: 'auto' | number;
    /**
     * The number of epochs to train the model for. An epoch refers to one full cycle
     * through the training dataset.
     */
    n_epochs?: 'auto' | number;
    /**
     * Level of reasoning effort.
     */
    reasoning_effort?: 'default' | 'low' | 'medium' | 'high';
}
/**
 * Configuration for the reinforcement fine-tuning method.
 */
export interface ReinforcementMethod {
    /**
     * The grader used for the fine-tuning job.
     */
    grader: GraderModelsAPI.StringCheckGrader | GraderModelsAPI.TextSimilarityGrader | GraderModelsAPI.PythonGrader | GraderModelsAPI.ScoreModelGrader | GraderModelsAPI.MultiGrader;
    /**
     * The hyperparameters used for the reinforcement fine-tuning job.
     */
    hyperparameters?: ReinforcementHyperparameters;
}
/**
 * The hyperparameters used for the fine-tuning job.
 */
export interface SupervisedHyperparameters {
    /**
     * Number of examples in each batch. A larger batch size means that model
     * parameters are updated less frequently, but with lower variance.
     */
    batch_size?: 'auto' | number;
    /**
     * Scaling factor for the learning rate. A smaller learning rate may be useful to
     * avoid overfitting.
     */
    learning_rate_multiplier?: 'auto' | number;
    /**
     * The number of epochs to train the model for. An epoch refers to one full cycle
     * through the training dataset.
     */
    n_epochs?: 'auto' | number;
}
/**
 * Configuration for the supervised fine-tuning method.
 */
export interface SupervisedMethod {
    /**
     * The hyperparameters used for the fine-tuning job.
     */
    hyperparameters?: SupervisedHyperparameters;
}
export declare namespace Methods {
    export { type DpoHyperparameters as DpoHyperparameters, type DpoMethod as DpoMethod, type ReinforcementHyperparameters as ReinforcementHyperparameters, type ReinforcementMethod as ReinforcementMethod, type SupervisedHyperparameters as SupervisedHyperparameters, type SupervisedMethod as SupervisedMethod, };
}
//# sourceMappingURL=methods.d.ts.map