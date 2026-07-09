# Anthropic J-Lens Research

## Official Sources

- Anthropic summary: https://www.anthropic.com/research/global-workspace
- Full paper: https://transformer-circuits.pub/2026/workspace/
- Reference code: https://github.com/anthropics/jacobian-lens
- Neuronpedia demo: https://www.neuronpedia.org/jlens

## Core Facts

Anthropic's technique is called the Jacobian lens, or J-Lens. It maps intermediate residual-stream activity into a token readout that approximates what a hidden activation is disposed to make the model verbalize later.

The paper defines a J-space as a sparse nonnegative combination of J-Lens vectors. Empirically, a small number of token-indexed vectors are active at a time, creating a workspace-like set of reportable concepts.

The work reports that J-Lens can surface concepts not present in the visible text, including intermediate math steps, bug recognition, prompt-injection suspicion, biological function from protein sequences, evaluation awareness, and some self-monitoring signals.

The paper also reports causal interventions: swapping a concept in J-space can alter later model output in tasks where that concept is used as an intermediate representation.

## Operational Meaning

Use J-Lens for two distinct operations:

- **Read**: inspect which concepts an activation appears to carry.
- **Write/intervene**: add, remove, or swap concept vectors to test causal influence.

Only call something a J-Lens readout when activations are available and the lens was actually applied.

## Reference Implementation

The `anthropics/jacobian-lens` repo is Apache-2.0 companion code. Its README describes:

- fitting a lens on open-weight decoder transformers
- applying a pretrained lens
- rendering layer-by-position slice views
- examples using Qwen

Typical setup:

```bash
git clone https://github.com/anthropics/jacobian-lens
cd jacobian-lens
pip install -e .
```

Typical use:

```python
import transformers, jlens

hf = transformers.AutoModelForCausalLM.from_pretrained("org/model").cuda()
tok = transformers.AutoTokenizer.from_pretrained("org/model")
model = jlens.from_hf(hf, tok)
lens = jlens.JacobianLens.from_pretrained("org/lens-repo", filename="model/lens.pt")
lens_logits, model_logits, _ = lens.apply(model, prompt, positions=[-2])
```

## Limitations

- Closed API models do not expose the activations needed for real J-Lens.
- J-Lens surfaces verbalizable representations, not every computation.
- Automatic or highly practiced computations may bypass J-space.
- Readouts are token-indexed approximations, not literal human thoughts.
- Layer and position selection matters.
- A harness skill can standardize observability, but cannot create activation access where none exists.

## Correct Labels

Use these labels:

- `activation-level J-Lens`: real lens over activations
- `J-Lens-style trace`: harness observability inspired by J-Lens
- `visible rationale`: model-provided summary or exposed reasoning
- `inferred rationale`: black-box inference from output/probes
- `not observable`: private activations or hidden chain-of-thought in a closed model
