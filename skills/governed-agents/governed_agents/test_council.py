from governed_agents.council import (
    generate_reviewer_prompt, aggregate_votes, CouncilVerdict,
)
from governed_agents.contract import TaskContract
from governed_agents.orchestrator import GovernedOrchestrator


def test_prompt_contains_objective():
    prompt = generate_reviewer_prompt("Build cache", ["Key expires", "TTL works"], "I built it")
    assert "Build cache" in prompt
    assert "Key expires" in prompt
    assert "TTL works" in prompt


def test_prompt_contains_json_schema():
    prompt = generate_reviewer_prompt("X", [], "Y")
    assert '"verdict"' in prompt
    assert "approve" in prompt
    assert "reject" in prompt


def test_majority_approve_passes():
    verdicts = [
        CouncilVerdict(reviewer_id="r1", verdict="approve", parse_success=True),
        CouncilVerdict(reviewer_id="r2", verdict="approve", parse_success=True),
        CouncilVerdict(reviewer_id="r3", verdict="reject", parse_success=True),
    ]
    result = aggregate_votes(verdicts)
    assert result.passed is True
    assert abs(result.score - 0.667) < 0.01


def test_majority_reject_fails():
    verdicts = [
        CouncilVerdict(reviewer_id="r1", verdict="reject", parse_success=True),
        CouncilVerdict(reviewer_id="r2", verdict="reject", parse_success=True),
        CouncilVerdict(reviewer_id="r3", verdict="approve", parse_success=True),
    ]
    result = aggregate_votes(verdicts)
    assert result.passed is False


def test_parse_failure_pessimistic():
    v = CouncilVerdict.from_output("this is not json at all", "r1")
    assert v.verdict == "reject"
    assert v.parse_success is False


def test_empty_council_fails():
    result = aggregate_votes([])
    assert result.passed is False
    assert result.score == 0.0


def test_generate_council_tasks_count():
    g = GovernedOrchestrator(
        contract=TaskContract(
            objective="Test", acceptance_criteria=["Works"],
            verification_mode="council", council_size=3,
        ),
        model="anthropic/claude-haiku-4-5",
    )
    prompts = g.generate_council_tasks("output here")
    assert len(prompts) == 3
    assert "[Reviewer 1/3]" in prompts[0]
    assert "[Reviewer 3/3]" in prompts[2]
