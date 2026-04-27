export function buildStatPlan(target, anchoredTarget) {
    return {
        checks: [{ target, options: { action: "stat files" } }],
        script: 'set -eu\ncd -- "$1"\nstat -c "%F|%s|%Y" -- "$2"',
        args: [anchoredTarget.canonicalParentPath, anchoredTarget.basename],
        allowFailure: true,
    };
}
