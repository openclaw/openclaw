# DSPy.rb Optimization

## MIPROv2

MIPROv2 (Multi-prompt Instruction Proposal with Retrieval Optimization) is the primary instruction tuner in DSPy.rb. It proposes new instructions and few-shot demonstrations per predictor, evaluates them on mini-batches, and retains candidates that improve the metric. It ships as a separate gem to keep the Gaussian Process dependency tree out of apps that do not need it.

### Installation

```ruby
# Gemfile
gem "dspy"
gem "dspy-miprov2"
```

Bundler auto-requires `dspy/miprov2`. No additional `require` statement is needed.

### AutoMode presets

Use `DSPy::Teleprompt::MIPROv2::AutoMode` for preconfigured optimizers:

```ruby
light  = DSPy::Teleprompt::MIPROv2::AutoMode.light(metric: metric)   # 6 trials, greedy
medium = DSPy::Teleprompt::MIPROv2::AutoMode.medium(metric: metric)  # 12 trials, adaptive
heavy  = DSPy::Teleprompt::MIPROv2::AutoMode.heavy(metric: metric)   # 18 trials, Bayesian
```

| Preset   | Trials | Strategy   | Use case                                            |
|----------|--------|------------|-----------------------------------------------------|
| `light`  | 6      | `:greedy`  | Quick wins on small datasets or during prototyping. |
| `medium` | 12     | `:adaptive`| Balanced exploration vs. runtime for most pilots.   |
| `heavy`  | 18     | `:bayesian`| Highest accuracy targets or multi-stage programs.   |

### Manual configuration with dry-configurable

`DSPy::Teleprompt::MIPROv2` includes `Dry::Configurable`. Configure at the class level (defaults for all instances) or instance level (overrides class defaults).

**Class-level defaults:**

```ruby
DSPy::Teleprompt::MIPROv2.configure do |config|
  config.optimization_strategy = :bayesian
  config.num_trials = 30
  config.bootstrap_sets = 10
end
```

**Instance-level overrides:**

```ruby
optimizer = DSPy::Teleprompt::MIPROv2.new(metric: metric)
optimizer.configure do |config|
  config.num_trials = 15
  config.num_instruction_candidates = 6
  config.bootstrap_sets = 5
  config.max_bootstrapped_examples = 4
  config.max_labeled_examples = 16
  config.optimization_strategy = :adaptive       # :greedy, :adaptive, :bayesian
  config.early_stopping_patience = 3
  config.init_temperature = 1.0
  config.final_temperature = 0.1
  config.minibatch_size = nil                     # nil = auto
  config.auto_seed = 42
end
```

The `optimization_strategy` setting accepts symbols (`:greedy`, `:adaptive`, `:bayesian`) and coerces them internally to `DSPy::Teleprompt::OptimizationStrategy` T::Enum values.

The old `config:` constructor parameter is removed. Passing `config:` raises `ArgumentError`.

### Auto presets via configure

Instead of `AutoMode`, set the preset through the configure block:

```ruby
optimizer = DSPy::Teleprompt::MIPROv2.new(metric: metric)
optimizer.configure do |config|
  config.auto_preset = DSPy::Teleprompt::AutoPreset.deserialize("medium")
end
```

### Compile and inspect

```ruby
program = DSPy::Predict.new(MySignature)

result = optimizer.compile(
  program,
  trainset: train_examples,
  valset: val_examples
)

optimized_program = result.optimized_program
puts "Best score: #{result.best_score_value}"
```

The `result` object exposes:
- `optimized_program` -- ready-to-use predictor with updated instruction and demos.
- `optimization_trace[:trial_logs]` -- per-trial record of instructions, demos, and scores.
- `metadata[:optimizer]` -- `"MIPROv2"`, useful when persisting experiments from multiple optimizers.

### Multi-stage programs

MIPROv2 generates dataset summaries for each predictor and proposes per-stage instructions. For a ReAct agent with `thought_generator` and `observation_processor` predictors, the optimizer handles credit assignment internally. The metric only needs to evaluate the final output.

### Bootstrap sampling

During the bootstrap phase MIPROv2:
1. Generates dataset summaries from the training set.
2. Bootstraps few-shot demonstrations by running the baseline program.
3. Proposes candidate instructions grounded in the summaries and bootstrapped examples.
4. Evaluates each candidate on mini-batches drawn from the validation set.

Control the bootstrap phase with `bootstrap_sets`, `max_bootstrapped_examples`, and `max_labeled_examples`.

### Bayesian optimization

When `optimization_strategy` is `:bayesian` (or when using the `heavy` preset), MIPROv2 fits a Gaussian Process surrogate over past trial scores to select the next candidate. This replaces random search with informed exploration, reducing the number of trials needed to find high-scoring instructions.

---

## GEPA

GEPA (Genetic-Pareto Reflective Prompt Evolution) is a feedback-driven optimizer. It runs the program on a small batch, collects scores and textual feedback, and asks a reflection LM to rewrite the instruction. Improved candidates are retained on a Pareto frontier.

### Installation

```ruby
# Gemfile
gem "dspy"
gem "dspy-gepa"
```

The `dspy-gepa` gem depends on the `gepa` core optimizer gem automatically.

### Metric contract

GEPA metrics return `DSPy::Prediction` with both a numeric score and a feedback string. Do not return a plain boolean.

```ruby
metric = lambda do |example, prediction|
  expected  = example.expected_values[:label]
  predicted = prediction.label

  score = predicted == expected ? 1.0 : 0.0
  feedback = if score == 1.0
    "Correct (#{expected}) for: \"#{example.input_values[:text][0..60]}\""
  else
    "Misclassified (expected #{expected}, got #{predicted}) for: \"#{example.input_values[:text][0..60]}\""
  end

  DSPy::Prediction.new(score: score, feedback: feedback)
end
```

Keep the score in `[0, 1]`. Always include a short feedback message explaining what happened -- GEPA hands this text to the reflection model so it can reason about failures.

### Feedback maps

`feedback_map` targets individual predictors inside a composite module. Each entry receives keyword arguments and returns a `DSPy::Prediction`:

```ruby
feedback_map = {
  'self' => lambda do |predictor_output:, predictor_inputs:, module_inputs:, module_outputs:, captured_trace:|
    expected  = module_inputs.expected_values[:label]
    predicted = predictor_output.label

    DSPy::Prediction.new(
      score: predicted == expected ? 1.0 : 0.0,
      feedback: "Classifier saw \"#{predictor_inputs[:text][0..80]}\" -> #{predicted} (expected #{expected})"
    )
  end
}
```

For single-predictor programs, key the map with `'self'`. For multi-predictor chains, add entries per component so the reflection LM sees localized context at each step. Omit `feedback_map` entirely if the top-level metric already covers the basics.

### Configuring the teleprompter

```ruby
teleprompter = DSPy::Teleprompt::GEPA.new(
  metric: metric,
  reflection_lm: DSPy::ReflectionLM.new('openai/gpt-4o-mini', api_key: ENV['OPENAI_API_KEY']),
  feedback_map: feedback_map,
  config: {
    max_metric_calls: 600,
    minibatch_size: 6,
    skip_perfect_score: false
  }
)
```

Key configuration knobs:

| Knob                 | Purpose                                                                                   |
|----------------------|-------------------------------------------------------------------------------------------|
| `max_metric_calls`   | Hard budget on evaluation calls. Set to at least the validation set size plus a few minibatches. |
| `minibatch_size`     | Examples per reflective replay batch. Smaller = cheaper iterations, noisier scores.       |
| `skip_perfect_score` | Set `true` to stop early when a candidate reaches score `1.0`.                            |

### Minibatch sizing

| Goal                                            | Suggested size | Rationale                                                  |
|-------------------------------------------------|----------------|------------------------------------------------------------|
| Explore many candidates within a tight budget   | 3--6           | Cheap iterations, more prompt variants, noisier metrics.   |
| Stable metrics when each rollout is costly      | 8--12          | Smoother scores, fewer candidates unless budget is raised. |
| Investigate specific failure modes              | 3--4 then 8+   | Start with breadth, increase once patterns emerge.         |

### Compile and evaluate

```ruby
program = DSPy::Predict.new(MySignature)

result = teleprompter.compile(program, trainset: train, valset: val)
optimized_program = result.optimized_program

test_metrics = evaluate(optimized_program, test)
```

The `result` object exposes:
- `optimized_program` -- predictor with updated instruction and few-shot examples.
- `best_score_value` -- validation score for the best candidate.
- `metadata` -- candidate counts, trace hashes, and telemetry IDs.

### Reflection LM

Swap `DSPy::ReflectionLM` for any callable object that accepts the reflection prompt hash and returns a string. The default reflection signature extracts the new instruction from triple backticks in the response.

### Experiment tracking

Plug `GEPA::Logging::ExperimentTracker` into a persistence layer:

```ruby
tracker = GEPA::Logging::ExperimentTracker.new
tracker.with_subscriber { |event| MyModel.create!(payload: event) }

teleprompter = DSPy::Teleprompt::GEPA.new(
  metric: metric,
  reflection_lm: reflection_lm,
  experiment_tracker: tracker,
  config: { max_metric_calls: 900 }
)
```

The tracker emits Pareto update events, merge decisions, and candidate evolution records as JSONL.

### Pareto frontier

GEPA maintains a diverse candidate pool and samples from the Pareto frontier instead of mutating only the top-scoring program. This balances exploration and prevents the search from collapsing onto a single lineage.

Enable the merge proposer after multiple strong lineages emerge:

```ruby
config: {
  max_metric_calls: 900,
  enable_merge_proposer: true
}
```

Premature merges eat budget without meaningful gains. Gate merge on having several validated candidates first.

### Advanced options

- `acceptance_strategy:` -- plug in bespoke Pareto filters or early-stop heuristics.
- Telemetry spans emit via `GEPA::Telemetry`. Enable global observability with `DSPy.configure { |c| c.observability = true }` to stream spans to an OpenTelemetry exporter.

---

## Evaluation Framework

`DSPy::Evals` provides batch evaluation of predictors against test datasets with built-in and custom metrics.

### Basic usage

```ruby
metric = proc do |example, prediction|
  prediction.answer == example.expected_values[:answer]
end

evaluator = DSPy::Evals.new(predictor, metric: metric)

result = evaluator.evaluate(
  test_examples,
  display_table: true,
  display_progress: true
)

puts "Pass rate: #{(result.pass_rate * 100).round(1)}%"
puts "Passed: #{result.passed_examples}/#{result.total_examples}"
```

### DSPy::Example

Convert raw data into `DSPy::Example` instances before passing to optimizers or evaluators. Each example carries `input_values` and `expected_values`:

```ruby
examples = rows.map do |row|
  DSPy::Example.new(
    input_values: { text: row[:text] },
    expected_values: { label: row[:label] }
  )
end

train, val, test = split_examples(examples, train_ratio: 0.6, val_ratio: 0.2, seed: 42)
```

Hold back a test set from the optimization loop. Optimizers work on train/val; only the test set proves generalization.

### Built-in metrics

```ruby
# Exact match -- prediction must exactly equal expected value
metric = DSPy::Metrics.exact_match(field: :answer, case_sensitive: true)

# Contains -- prediction must contain expected substring
metric = DSPy::Metrics.contains(field: :answer, case_sensitive: false)

# Numeric difference -- numeric output within tolerance
metric = DSPy::Metrics.numeric_difference(field: :answer, tolerance: 0.01)

# Composite AND -- all sub-metrics must pass
metric = DSPy::Metrics.composite_and(
  DSPy::Metrics.exact_match(field: :answer),
  DSPy::Metrics.contains(field: :reasoning)
)
```

### Custom metrics

```ruby
quality_metric = lambda do |example, prediction|
  return false unless prediction

  score = 0.0
  score += 0.5 if prediction.answer == example.expected_values[:answer]
  score += 0.3 if prediction.explanation && prediction.explanation.length > 50
  score += 0.2 if prediction.confidence && prediction.confidence > 0.8
  score >= 0.7
end

evaluator = DSPy::Evals.new(predictor, metric: quality_metric)
```

Access prediction fields with dot notation (`prediction.answer`), not hash notation.

### Observability hooks

Register callbacks without editing the evaluator:

```ruby
DSPy::Evals.before_example do |payload|
  example = payload[:example]
  DSPy.logger.info("Evaluating example #{example.id}") if example.respond_to?(:id)
end

DSPy::Evals.after_batch do |payload|
  result = payload[:result]
  Langfuse.event(
    name: 'eval.batch',
    metadata: {
      total: result.total_examples,
      passed: result.passed_examples,
      score: result.score
    }
  )
end
```

Available hooks: `before_example`, `after_example`, `before_batch`, `after_batch`.

### Langfuse score export

Enable `export_scores: true` to emit `score.create` events for each evaluated example and a batch score at the end:

```ruby
evaluator = DSPy::Evals.new(
  predictor,
  metric: metric,
  export_scores: true,
  score_name: 'qa_accuracy'   # default: 'evaluation'
)

result = evaluator.evaluate(test_examples)
# Emits per-example scores + overall batch score via DSPy::Scores::Exporter
```

Scores attach to the current trace context automatically and flow to Langfuse asynchronously.

### Evaluation results

```ruby
result = evaluator.evaluate(test_examples)

result.score            # Overall score (0.0 to 1.0)
result.passed_count     # Examples that passed
result.failed_count     # Examples that failed
result.error_count      # Examples that errored

result.results.each do |r|
  r.passed              # Boolean
  r.score               # Numeric score
  r.error               # Error message if the example errored
end
```

### Integration with optimizers

```ruby
metric = proc do |example, prediction|
  expected  = example.expected_values[:answer].to_s.strip.downcase
  predicted = prediction.answer.to_s.strip.downcase
  !expected.empty? && predicted.include?(expected)
end

optimizer = DSPy::Teleprompt::MIPROv2::AutoMode.medium(metric: metric)

result = optimizer.compile(
  DSPy::Predict.new(QASignature),
  trainset: train_examples,
  valset: val_examples
)

evaluator = DSPy::Evals.new(result.optimized_program, metric: metric)
test_result = evaluator.evaluate(test_examples, display_table: true)
puts "Test accuracy: #{(test_result.pass_rate * 100).round(2)}%"
```

---

## Storage System

`DSPy::Storage` persists optimization results, tracks history, and manages multiple versions of optimized programs.

### ProgramStorage (low-level)

```ruby
storage = DSPy::Storage::ProgramStorage.new(storage_path: "./dspy_storage")

# Save
saved = storage.save_program(
  result.optimized_program,
  result,
  metadata: {
    signature_class: 'ClassifyText',
    optimizer: 'MIPROv2',
    examples_count: examples.size
  }
)
puts "Stored with ID: #{saved.program_id}"

# Load
saved = storage.load_program(program_id)
predictor = saved.program
score = saved.optimization_result[:best_score_value]

# List
storage.list_programs.each do |p|
  puts "#{p[:program_id]} -- score: #{p[:best_score]} -- saved: #{p[:saved_at]}"
end
```

### StorageManager (recommended)

```ruby
manager = DSPy::Storage::StorageManager.new

# Save with tags
saved = manager.save_optimization_result(
  result,
  tags: ['production', 'sentiment-analysis'],
  description: 'Optimized sentiment classifier v2'
)

# Find programs
programs = manager.find_programs(
  optimizer: 'MIPROv2',
  min_score: 0.85,
  tags: ['production']
)

recent = manager.find_programs(
  max_age_days: 7,
  signature_class: 'ClassifyText'
)

# Get best program for a signature
best = manager.get_best_program('ClassifyText')
predictor = best.program
```

Global shorthand:

```ruby
DSPy::Storage::StorageManager.save(result, metadata: { version: '2.0' })
DSPy::Storage::StorageManager.load(program_id)
DSPy::Storage::StorageManager.best('ClassifyText')
```

### Checkpoints

Create and restore checkpoints during long-running optimizations:

```ruby
# Save a checkpoint
manager.create_checkpoint(
  current_result,
  'iteration_50',
  metadata: { iteration: 50, current_score: 0.87 }
)

# Restore
restored = manager.restore_checkpoint('iteration_50')
program = restored.program

# Auto-checkpoint every N iterations
if iteration % 10 == 0
  manager.create_checkpoint(current_result, "auto_checkpoint_#{iteration}")
end
```

### Import and export

Share programs between environments:

```ruby
storage = DSPy::Storage::ProgramStorage.new

# Export
storage.export_programs(['abc123', 'def456'], './export_backup.json')

# Import
imported = storage.import_programs('./export_backup.json')
puts "Imported #{imported.size} programs"
```

### Optimization history

```ruby
history = manager.get_optimization_history

history[:summary][:total_programs]
history[:summary][:avg_score]

history[:optimizer_stats].each do |optimizer, stats|
  puts "#{optimizer}: #{stats[:count]} programs, best: #{stats[:best_score]}"
end

history[:trends][:improvement_percentage]
```

### Program comparison

```ruby
comparison = manager.compare_programs(id_a, id_b)
comparison[:comparison][:score_difference]
comparison[:comparison][:better_program]
comparison[:comparison][:age_difference_hours]
```

### Storage configuration

```ruby
config = DSPy::Storage::StorageManager::StorageConfig.new
config.storage_path = Rails.root.join('dspy_storage')
config.auto_save = true
config.save_intermediate_results = false
config.max_stored_programs = 100

manager = DSPy::Storage::StorageManager.new(config: config)
```

### Cleanup

Remove old programs. Cleanup retains the best performing and most recent programs using a weighted score (70% performance, 30% recency):

```ruby
deleted_count = manager.cleanup_old_programs
```

### Storage events

The storage system emits structured log events for monitoring:
- `dspy.storage.save_start`, `dspy.storage.save_complete`, `dspy.storage.save_error`
- `dspy.storage.load_start`, `dspy.storage.load_complete`, `dspy.storage.load_error`
- `dspy.storage.delete`, `dspy.storage.export`, `dspy.storage.import`, `dspy.storage.cleanup`

### File layout

```
dspy_storage/
  programs/
    abc123def456.json
    789xyz012345.json
  history.json
```

---

## API rules

- Call predictors with `.call()`, not `.forward()`.
- Access prediction fields with dot notation (`result.answer`), not hash notation (`result[:answer]`).
- GEPA metrics return `DSPy::Prediction.new(score:, feedback:)`, not a boolean.
- MIPROv2 metrics may return `true`/`false`, a numeric score, or `DSPy::Prediction`.
