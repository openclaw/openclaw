#!/usr/bin/env pwsh

# Fix 1: Make ResolvedBehaviorRule and validateBehaviorOutput non-exported
$policyFile = "C:\dev\openclaw\src\security\behavior-policy.ts"
$content = [System.IO.File]::ReadAllText($policyFile, [System.Text.UTF8Encoding]::new($false))

# Remove "export" from ResolvedBehaviorRule type
$content = $content -replace "export type ResolvedBehaviorRule", "type ResolvedBehaviorRule"

# Remove "export" from validateBehaviorOutput
$content = $content -replace "export async function validateBehaviorOutput", "async function validateBehaviorOutput"

[System.IO.File]::WriteAllText($policyFile, $content, [System.Text.UTF8Encoding]::new($false))
Write-Output "Fixed behavior-policy.ts"

# Fix 2: Replace `rules!` patterns with if-guard in test file
$testFile = "C:\dev\openclaw\src\security\behavior-policy.test.ts"
$testContent = [System.IO.File]::ReadAllText($testFile, [System.Text.UTF8Encoding]::new($false))

# Replace the resolveBehaviorRules test that uses rules!
$oldTest = @"
    it("returns resolved rules with defaults applied", () => {
      const cfg = makeConfig([SAMPLE_RULE, SAMPLE_RULE_GUIDE]);
      const rules = resolveBehaviorRules(cfg);
      expect(rules).toBeDefined();
      expect(rules!).toHaveLength(2);
      expect(rules![0].id).toBe("test-no-secrets");
      expect(rules![0].mode).toBe("enforce");
      expect(rules![1].id).toBe("test-politeness");
      expect(rules![1].mode).toBe("guide");
    });
"@

$newTest = @"
    it("returns resolved rules with defaults applied", () => {
      const cfg = makeConfig([SAMPLE_RULE, SAMPLE_RULE_GUIDE]);
      const rules = resolveBehaviorRules(cfg);
      expect(rules).toBeDefined();
      if (rules) {
        expect(rules).toHaveLength(2);
        expect(rules[0].id).toBe("test-no-secrets");
        expect(rules[0].mode).toBe("enforce");
        expect(rules[1].id).toBe("test-politeness");
        expect(rules[1].mode).toBe("guide");
      }
    });
"@

$testContent = $testContent.Replace($oldTest, $newTest)

# Replace `result.violations!.length` and `result.violations![0].ruleId`
$testContent = $testContent.Replace("expect(result.violations!.length).toBe(1)", "expect(result.violations?.length ?? 0).toBe(1)")
$testContent = $testContent.Replace("expect(result.violations![0].ruleId).toBe("no-secrets")", "if (result.violations) { expect(result.violations[0].ruleId).toBe("no-secrets") }")

[System.IO.File]::WriteAllText($testFile, $testContent, [System.Text.UTF8Encoding]::new($false))
Write-Output "Fixed behavior-policy.test.ts"

Write-Output "All fixes applied"
