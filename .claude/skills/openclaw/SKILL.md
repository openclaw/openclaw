openclaw Development Patterns

    > Auto-generated skill from repository analysis

     Overview
    This skill teaches you the core development patterns, coding conventions, and collaborative workflows used in the openclaw codebase. openclaw is a TypeScript project using the Express framework, with a strong emphasis on modularity, test coverage, and clear changelogs. You'll learn how to contribute features, fix bugs, manage providers/extensions, prepare releases, refactor tests, and update plugin SDKs—all following the project's established conventions.

     Coding Conventions

    - File Naming:
      Use kebab-case for all file and directory names.
      Example:

src/user-service.ts extensions/image-generation/image-provider.ts

    - Import Style:
    Use relative imports for internal modules.
    Example:
    typescript
    import { getUser } from './user-service'
    import { ImageProvider } from '../image-generation/image-provider'

Export Style:  
 Use named exports for all modules.  
 Example:

        // Good
        export function getUser(id: string) { ... }
        export const USERROLE = 'admin'

        // Avoid default exports

Commit Messages:  
 Use conventional commit prefixes: fix, test, refactor.  
 Keep messages concise (55 characters).  
 Example:

        fix: handle null user in getUserById
        test: add coverage for image provider errors
        refactor: collapse telegram test suites

## Workflows

Feature or Bugfix with Tests and Changelog

Trigger: When adding a new feature or fixing a bug that requires validation and release notes  
Command: /feature-or-bugfix-with-tests-and-changelog

1.  Implement code changes in relevant source files (src/ or extensions/).
2.  Add or update corresponding test files (.test.ts) in the same or related directory.
3.  Update CHANGELOG.md to document the change.

Example:

    // src/user-service.ts
    export function createUser(name: string) { ... }

    // src/user-service.test.ts
    import { createUser } from './user-service'
    test('creates a user', () => { ... })


    // CHANGELOG.md
    - feat: add createUser to user-service

## Testing Patterns

Framework: [vitest](https://vitest.dev/)
Test File Pattern: Files end with .test.ts and are placed alongside or near the code they test.
Example:

        // src/foo.test.ts
        import { foo } from './foo'

        test('foo returns bar', () => {
          expect(foo()).toBe('bar')
        })

## Commands

Command

Purpose

/feature-or-bugfix-with-tests-and-changelog

Add a feature or fix a bug with tests and changelog update

/feature-development

Implement a new feature with tests and documentation

/refactoring

Refactor code structure while keeping tests green
