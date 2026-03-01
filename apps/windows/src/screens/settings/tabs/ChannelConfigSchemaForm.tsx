import type { JSX } from "react";
import {
  Button,
  Field,
  Input,
  Switch,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  type ConfigPath,
  type ConfigSchemaNode,
  type ConfigUiHint,
  allowsAdditional,
  asArray,
  asRecord,
  cloneDeep,
  hintForPath,
  indexSegment,
  isNullSchema,
  isSensitivePath,
  keySegment,
  schemaAdditional,
  schemaAnyOf,
  schemaDefault,
  schemaDescription,
  schemaEnum,
  schemaItems,
  schemaLiteral,
  schemaOneOf,
  schemaProperties,
  schemaTitle,
  schemaType,
} from "./channel-config-schema-utils";

interface ChannelConfigSchemaFormProps {
  schema: ConfigSchemaNode;
  basePath: ConfigPath;
  hints: Record<string, ConfigUiHint>;
  getValue: (path: ConfigPath) => unknown;
  setValue: (path: ConfigPath, value: unknown | undefined) => void;
  disabled?: boolean;
}

const useStyles = makeStyles({
  group: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  node: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "8px 0",
  },
  objectBody: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    paddingLeft: "8px",
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  },
  helper: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  arrayItem: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "6px",
    padding: "8px",
  },
  mapKeyInput: {
    width: "220px",
  },
  select: {
    minHeight: "32px",
    padding: "4px 8px",
    borderRadius: "4px",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
});

function compareLiteral(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function nodeVariant(node: ConfigSchemaNode): ConfigSchemaNode {
  const variants =
    schemaAnyOf(node).length > 0 ? schemaAnyOf(node) : schemaOneOf(node);
  if (variants.length === 0) return node;
  const nonNull = variants.filter((entry) => !isNullSchema(entry));
  if (nonNull.length === 1) return nonNull[0];
  return node;
}

function orderedPropertyKeys(
  path: ConfigPath,
  node: ConfigSchemaNode,
  hints: Record<string, ConfigUiHint>
): string[] {
  const properties = schemaProperties(node);
  const keys = Object.keys(properties);
  return keys.sort((lhs, rhs) => {
    const lhsOrder = hintForPath([...path, keySegment(lhs)], hints)?.order ?? 0;
    const rhsOrder = hintForPath([...path, keySegment(rhs)], hints)?.order ?? 0;
    if (lhsOrder !== rhsOrder) return lhsOrder - rhsOrder;
    return lhs.localeCompare(rhs);
  });
}

function valueAsString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function labelFor(
  path: ConfigPath,
  node: ConfigSchemaNode,
  hints: Record<string, ConfigUiHint>
): string {
  const lastSegment = path[path.length - 1];
  const fallbackLabel =
    lastSegment && lastSegment.kind === "key" ? lastSegment.key : "Field";
  return hintForPath(path, hints)?.label ?? schemaTitle(node) ?? fallbackLabel;
}

function helpFor(
  path: ConfigPath,
  node: ConfigSchemaNode,
  hints: Record<string, ConfigUiHint>
): string | undefined {
  return hintForPath(path, hints)?.help ?? schemaDescription(node);
}

export function ChannelConfigSchemaForm({
  schema,
  basePath,
  hints,
  getValue,
  setValue,
  disabled,
}: ChannelConfigSchemaFormProps) {
  const styles = useStyles();

  const renderNode = (
    rawNode: ConfigSchemaNode,
    path: ConfigPath
  ): JSX.Element => {
    const node = nodeVariant(rawNode);
    const label = labelFor(path, node, hints);
    const help = helpFor(path, node, hints);
    const current = getValue(path);

    const variants =
      schemaAnyOf(node).length > 0 ? schemaAnyOf(node) : schemaOneOf(node);
    if (variants.length > 0) {
      const nonNull = variants.filter((entry) => !isNullSchema(entry));
      const literals = nonNull
        .map(schemaLiteral)
        .filter((entry) => entry !== undefined);
      if (literals.length > 0 && literals.length === nonNull.length) {
        const selectedIndex = literals.findIndex((literal) =>
          compareLiteral(literal, current)
        );
        return (
          <div className={styles.node}>
            <Field label={label} hint={help}>
              <select
                className={styles.select}
                disabled={disabled}
                value={selectedIndex >= 0 ? String(selectedIndex) : ""}
                onChange={(event) => {
                  const index = Number.parseInt(event.target.value, 10);
                  if (
                    Number.isNaN(index) ||
                    index < 0 ||
                    index >= literals.length
                  ) {
                    setValue(path, undefined);
                  } else {
                    setValue(path, literals[index]);
                  }
                }}
              >
                <option value="">Select...</option>
                {literals.map((literal, index) => (
                  <option key={String(index)} value={String(index)}>
                    {valueAsString(literal)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        );
      }
      if (nonNull.length === 1) {
        return renderNode(nonNull[0], path);
      }
    }

    switch (schemaType(node)) {
      case "object": {
        const properties = schemaProperties(node);
        const keys = orderedPropertyKeys(path, node, hints);
        const objectValue = asRecord(current) ? current : {};
        const additionalSchema = schemaAdditional(node);
        const extras = Object.keys(objectValue)
          .filter((key) => !(key in properties))
          .sort((a, b) => a.localeCompare(b));

        return (
          <div className={styles.node}>
            <Text weight="semibold">{label}</Text>
            {help && <Text className={styles.helper}>{help}</Text>}
            <div className={styles.objectBody}>
              {keys.map((key) => {
                const child = properties[key];
                return (
                  <div key={key}>
                    {renderNode(child, [...path, keySegment(key)])}
                  </div>
                );
              })}

              {allowsAdditional(node) && additionalSchema && (
                <div className={styles.group}>
                  <Text weight="semibold">Extra entries</Text>
                  {extras.length === 0 && (
                    <Text className={styles.helper}>No extra entries yet.</Text>
                  )}
                  {extras.map((key) => {
                    const itemPath = [...path, keySegment(key)];
                    return (
                      <div key={key} className={styles.arrayItem}>
                        <div className={styles.row}>
                          <Input
                            className={styles.mapKeyInput}
                            value={key}
                            disabled={disabled}
                            onChange={(_, data) => {
                              const nextKey = data.value.trim();
                              if (!nextKey || nextKey === key) return;
                              const currentValue = getValue(path);
                              if (!asRecord(currentValue)) return;
                              if (nextKey in currentValue) return;
                              const nextObject = cloneDeep(currentValue);
                              nextObject[nextKey] = nextObject[key];
                              delete nextObject[key];
                              setValue(path, nextObject);
                            }}
                          />
                          <Button
                            appearance="secondary"
                            disabled={disabled}
                            onClick={() => {
                              const currentValue = getValue(path);
                              if (!asRecord(currentValue)) return;
                              const nextObject = cloneDeep(currentValue);
                              delete nextObject[key];
                              setValue(path, nextObject);
                            }}
                          >
                            Remove
                          </Button>
                        </div>
                        <div>{renderNode(additionalSchema, itemPath)}</div>
                      </div>
                    );
                  })}

                  <Button
                    appearance="secondary"
                    disabled={disabled}
                    onClick={() => {
                      const currentValue = getValue(path);
                      const nextObject = asRecord(currentValue)
                        ? cloneDeep(currentValue)
                        : {};
                      let index = 1;
                      let key = `new-${index}`;
                      while (key in nextObject) {
                        index += 1;
                        key = `new-${index}`;
                      }
                      nextObject[key] = schemaDefault(additionalSchema);
                      setValue(path, nextObject);
                    }}
                  >
                    Add
                  </Button>
                </div>
              )}
            </div>
          </div>
        );
      }
      case "array": {
        const items = asArray(current);
        const itemSchema = schemaItems(node);
        return (
          <div className={styles.node}>
            <Text weight="semibold">{label}</Text>
            {help && <Text className={styles.helper}>{help}</Text>}
            <div className={styles.group}>
              {items.map((_, index) => {
                const itemPath = [...path, indexSegment(index)];
                return (
                  <div key={String(index)} className={styles.arrayItem}>
                    {itemSchema ? (
                      renderNode(itemSchema, itemPath)
                    ) : (
                      <Text>{valueAsString(items[index])}</Text>
                    )}
                    <Button
                      appearance="secondary"
                      disabled={disabled}
                      onClick={() => {
                        const next = [...items];
                        next.splice(index, 1);
                        setValue(path, next);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                );
              })}
              <Button
                appearance="secondary"
                disabled={disabled}
                onClick={() => {
                  const next = [...items];
                  next.push(itemSchema ? schemaDefault(itemSchema) : "");
                  setValue(path, next);
                }}
              >
                Add
              </Button>
            </div>
          </div>
        );
      }
      case "boolean": {
        const checked =
          typeof current === "boolean" ? current : Boolean(schemaDefault(node));
        return (
          <div className={styles.node}>
            <Switch
              checked={checked}
              disabled={disabled}
              label={label}
              onChange={(_, data) => setValue(path, data.checked)}
            />
            {help && <Text className={styles.helper}>{help}</Text>}
          </div>
        );
      }
      case "number":
      case "integer": {
        const isInteger = schemaType(node) === "integer";
        const currentText = valueAsString(current ?? schemaDefault(node));
        return (
          <div className={styles.node}>
            <Field label={label} hint={help}>
              <Input
                disabled={disabled}
                value={currentText}
                onChange={(_, data) => {
                  const trimmed = data.value.trim();
                  if (!trimmed) {
                    setValue(path, undefined);
                    return;
                  }
                  const parsed = Number(trimmed);
                  if (!Number.isFinite(parsed)) return;
                  setValue(path, isInteger ? Math.trunc(parsed) : parsed);
                }}
              />
            </Field>
          </div>
        );
      }
      case "string": {
        const hint = hintForPath(path, hints);
        const placeholder = hint?.placeholder ?? "";
        const sensitive = hint?.sensitive ?? isSensitivePath(path);
        const enumValues = schemaEnum(node);
        const currentString = valueAsString(current ?? "");

        if (enumValues && enumValues.length > 0) {
          const selectedIndex = enumValues.findIndex((entry) =>
            compareLiteral(entry, current)
          );
          return (
            <div className={styles.node}>
              <Field label={label} hint={help}>
                <select
                  className={styles.select}
                  disabled={disabled}
                  value={selectedIndex >= 0 ? String(selectedIndex) : ""}
                  onChange={(event) => {
                    const index = Number.parseInt(event.target.value, 10);
                    if (
                      Number.isNaN(index) ||
                      index < 0 ||
                      index >= enumValues.length
                    ) {
                      setValue(path, undefined);
                    } else {
                      setValue(path, enumValues[index]);
                    }
                  }}
                >
                  <option value="">Select...</option>
                  {enumValues.map((entry, index) => (
                    <option key={String(index)} value={String(index)}>
                      {valueAsString(entry)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          );
        }

        return (
          <div className={styles.node}>
            <Field label={label} hint={help}>
              <Input
                type={sensitive ? "password" : "text"}
                placeholder={placeholder}
                disabled={disabled}
                value={currentString}
                onChange={(_, data) => {
                  const trimmed = data.value.trim();
                  setValue(path, trimmed.length === 0 ? undefined : data.value);
                }}
              />
            </Field>
          </div>
        );
      }
      default:
        return (
          <div className={styles.node}>
            <Text weight="semibold">{label}</Text>
            {help && <Text className={styles.helper}>{help}</Text>}
            <Text className={styles.helper}>Unsupported field type.</Text>
          </div>
        );
    }
  };

  return <div className={styles.group}>{renderNode(schema, basePath)}</div>;
}
